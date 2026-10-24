"""
Replays the draft rule over every default episode in the last 12 months and compares it with the
current rule.

Run from the workspace root:  python harness/backtest.py

An episode is a client's invoices due on the same day, paid (or still unpaid) after the grace period.
For each one the backtest works out the restriction the current rule would have applied, applies the
draft rule on top, and reports what changes, what it costs and who was restricted although they were
about to pay. The assumptions are printed with the results. The last line is `RESULT <json>`.
"""

import json
import sys
from datetime import date, timedelta
from pathlib import Path

from run_tests import (
    PRODUCT_LEVER,
    apply_rule,
    days_between,
    facts_at,
    gentleness,
    load_data,
    parse_actions,
    read_rule,
    validate_rule,
)

NEVER_SIMULATED = {"FEE_DEBIT", "FULL_FREEZE"}


def add_days(iso: str, days: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()


def assumptions(task: dict) -> list:
    return [
        "Episode: a client's invoices due on the same day, paid after the grace period or still unpaid.",
        ("Restriction date: the decision date of a precedent from this policy family for the episode when "
        "there is one, otherwise due date + grace + 1 + cure days from today's contract."),
        ("Current rule: the steps that precedent proposed; otherwise pol-003 as applied in history: hold the "
        "amount owed (when the contract has a set-off clause) plus the gentlest step on each unpaid "
        "product's lever."),
        "Clients pay on the same dates under the draft as they actually did; behaviour changes are not modelled.",
        ("Days to pay = last payment applied to the episode's invoices minus the restriction date (actual "
        "payments; invoice paid_on when no application is recorded)."),
        "Amount restricted = the amount owed held from withdrawals; steps on other levers are counted, not priced.",
        "Renewal dates: the client's current renewal_on plus dates implied by precedent notes ('renewal in N days').",
        "Tier, segment, hedged positions, levers in use and contract clauses are today's values, not as of the episode.",
        (f"Money in transit: an ACH payment for the episode's invoices that settled within {task['transitDays']} "
        "days after the restriction date, or a payment pending or in transit on that date."),
        (f"Wrongly restricted: restricted, then paid within {task['paidWithinDays']} days of the restriction date "
        "or had money in transit."),
    ]


def payment_index(data: dict) -> tuple:
    movements = {m["id"]: m for m in data["payments"]["movements"]}
    paid_on, by_invoice = {}, {}
    for app in data["payments"]["applications"]:
        m = movements.get(app["movement_id"])
        if app.get("reversed") or m is None:
            continue
        by_invoice.setdefault(app["invoice_id"], []).append(m)
        if m.get("status") == "posted":
            paid_on[app["invoice_id"]] = max(paid_on.get(app["invoice_id"], ""), m["value_on"])
    return movements, paid_on, by_invoice


def simulated_steps(client_id: str, products: set, data: dict) -> frozenset:
    in_use = {lv["lever"] for lv in data["levers"] if lv["client_id"] == client_id and lv["state"] != "not_used"}
    clauses = (data["contracts"].get(client_id) or {}).get("clauses", {})
    rank = gentleness(data["capability"])
    out = set()
    if clauses.get("set_off") and "withdrawals" in in_use:
        out.add("withdrawals:HOLD_AMOUNT_OWED")
    for product in sorted(products):
        lever = PRODUCT_LEVER.get(product)
        if lever in (None, "withdrawals") or lever not in in_use:
            continue
        steps = sorted(
            (g, step) for (lv, step), g in rank.items()
            if lv == lever and step not in NEVER_SIMULATED and (step != "REQUIRE_PREPAY" or clauses.get("prepay"))
        )
        if steps:
            out.add(f"{lever}:{steps[0][1]}")
    return frozenset(out)


def money_in_transit(client_id: str, invoice_ids: set, on: str, data: dict, movements: dict, by_invoice: dict,
                     transit_days: int) -> bool:
    for invoice_id in invoice_ids:
        for m in by_invoice.get(invoice_id, []):
            if m.get("rail") == "ACH" and on < m["value_on"] <= add_days(on, transit_days):
                return True
    for m in movements.values():
        refs = set(m.get("refs") or [])
        mine = client_id in refs or bool(refs & invoice_ids)
        waiting = m.get("match_status") == "in_transit" or m.get("status") == "pending"
        if mine and waiting and m["value_on"] <= on:
            return True
    return False


def episodes(data: dict, rule: dict) -> list:
    task = data["task"]
    today, since = task["today"], task["windowFrom"]
    family = set(task["policyRefs"])
    movements, paid_on, by_invoice = payment_index(data)
    groups = {}
    for inv in data["invoices"]:
        if inv["status"] in ("void", "disputed") or inv["due_on"] < since or inv["due_on"] >= today:
            continue
        contract = data["contracts"].get(inv["client_id"])
        if not contract:
            continue
        paid = paid_on.get(inv["id"]) or inv.get("paid_on")
        if days_between(inv["due_on"], paid or today) > contract["grace_days"]:
            groups.setdefault((inv["client_id"], inv["due_on"]), []).append((inv, paid))

    out = []
    for (client_id, due_on), rows in sorted(groups.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        contract = data["contracts"][client_id]
        paid = None if any(p is None for _, p in rows) else max(p for _, p in rows)
        end = paid or today
        tied = sorted(
            (p for p in data["precedents"]
             if p["client_id"] == client_id and p["policy_ref"] in family and due_on <= p["decided_on"] <= end
             and parse_actions(p["proposed"]) is not None),
            key=lambda p: p["decided_on"],
        )
        products = {inv["product"] for inv, _ in rows}
        if tied:
            precedent = tied[0]
            on, source = precedent["decided_on"], f"precedent {precedent['id']}"
            current = parse_actions(precedent["proposed"])
            situation = precedent.get("situation") or ""
        else:
            on, source = add_days(due_on, contract["grace_days"] + 1 + contract["cure_days"]), "contract"
            current = simulated_steps(client_id, products, data)
            situation = ""
        restricted = bool(current) and on <= today and (paid is None or paid > on)
        open_rows = [(inv, p) for inv, p in rows if p is None or p > on]
        owed = sum(inv["amount_cents"] for inv, _ in open_rows)
        facts = facts_at(client_id, on, data, situation, current)
        draft = apply_rule(rule, facts, current, data["capability"]) if restricted else current
        days_to_pay = days_between(on, paid) if paid else None
        ids = {inv["id"] for inv, _ in rows}
        quick = days_to_pay is not None and days_to_pay <= task["paidWithinDays"]
        transit = money_in_transit(client_id, ids, on, data, movements, by_invoice, task["transitDays"])
        client = data["clients"].get(client_id) or {}
        out.append({
            "clientId": client_id, "client": client.get("name", client_id), "dueOn": due_on,
            "invoiceIds": sorted(ids), "restrictionOn": on, "basis": source, "restricted": restricted,
            "owedCents": owed if restricted else 0, "paidOn": paid, "daysToPay": days_to_pay if restricted else None,
            "current": sorted(current) if restricted else [], "draft": sorted(draft) if restricted else [],
            "paidQuickly": restricted and quick, "moneyInTransit": restricted and transit,
            "facts": {k: facts[k] for k in ("tier", "days_late", "renewal_in_days", "hedged")},
        })
    return out


def scenario(eps: list, key: str, today: str) -> dict:
    hit = [e for e in eps if e["restricted"] and e[key]]
    held = [e for e in hit if any(a.startswith("withdrawals:") for a in e[key])]
    wrong = [e for e in hit if e["paidQuickly"] or e["moneyInTransit"]]
    return {
        "episodesRestricted": len(hit),
        "leverSteps": sum(len(e[key]) for e in hit),
        "restrictedCents": sum(e["owedCents"] for e in held),
        "restrictedCentDays": sum(
            e["owedCents"] * (e["daysToPay"] if e["daysToPay"] is not None else days_between(e["restrictionOn"], today))
            for e in held
        ),
        "wronglyRestricted": {
            "episodes": len(wrong),
            "leverSteps": sum(len(e[key]) for e in wrong),
            "clients": sorted({e["client"] for e in wrong}),
        },
    }


def backtest(root: Path) -> dict:
    data = load_data(root / "data")
    task = data["task"]
    rule, errors = read_rule(root / "policies", task["policyId"])
    if rule is not None:
        errors += validate_rule(rule, task["policyId"], data["capability"])
    if errors:
        return {"ok": False, "errors": errors}
    eps = episodes(data, rule)
    changed = [e for e in eps if e["current"] != e["draft"]]
    pays = [e["daysToPay"] for e in changed if e["daysToPay"] is not None]
    current, draft = scenario(eps, "current", task["today"]), scenario(eps, "draft", task["today"])
    return {
        "ok": True,
        "window": {"from": task["windowFrom"], "to": task["today"]},
        "episodes": len(eps),
        "restrictedUnderCurrent": current["episodesRestricted"],
        "casesChanged": len(changed),
        "changed": [
            {k: e[k] for k in ("client", "clientId", "dueOn", "restrictionOn", "basis", "current", "draft",
                               "owedCents", "paidOn", "daysToPay", "paidQuickly", "moneyInTransit", "facts")}
            for e in changed
        ],
        "money": {
            "current": {k: current[k] for k in ("restrictedCents", "restrictedCentDays", "leverSteps")},
            "draft": {k: draft[k] for k in ("restrictedCents", "restrictedCentDays", "leverSteps")},
            "changedCasesAvgDaysToPay": round(sum(pays) / len(pays), 1) if pays else None,
        },
        "wronglyRestricted": {
            "paidWithinDays": task["paidWithinDays"],
            "current": current["wronglyRestricted"],
            "draft": draft["wronglyRestricted"],
        },
        "assumptions": assumptions(task),
    }


def usd(cents: int) -> str:
    return f"${cents / 100:,.2f}"


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    result = backtest(root)
    if not result["ok"]:
        for error in result["errors"]:
            print(f"ERROR rule: {error}")
        print("RESULT " + json.dumps(result))
        return 1
    print(f"Window {result['window']['from']} .. {result['window']['to']}: {result['episodes']} default episodes, "
          f"{result['restrictedUnderCurrent']} restricted under the current rule, {result['casesChanged']} changed "
          "by the draft.")
    for e in result["changed"]:
        paid = "still unpaid" if e["daysToPay"] is None else f"paid after {e['daysToPay']} days"
        print(f"  {e['client']} due {e['dueOn']}, restricted {e['restrictionOn']} ({e['basis']}): {e['current']} -> "
              f"{e['draft']}; owed {usd(e['owedCents'])}, {paid}"
              f"{' (paid quickly)' if e['paidQuickly'] else ''}{' (money in transit)' if e['moneyInTransit'] else ''}")
    for name in ("current", "draft"):
        m, w = result["money"][name], result["wronglyRestricted"][name]
        print(f"{name}: {usd(m['restrictedCents'])} held, {m['leverSteps']} lever steps; wrongly restricted "
              f"{w['episodes']} episodes / {w['leverSteps']} steps ({', '.join(w['clients']) or 'none'})")
    print("Assumptions:")
    for line in result["assumptions"]:
        print(f"  - {line}")
    print("RESULT " + json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
