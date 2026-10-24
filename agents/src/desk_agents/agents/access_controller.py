import json
import logging
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from ..config import settings
from ..models import Proposal
from ..stdb import ReducerError
from ..world import ClientView, Row, World, load_world
from .base import Agent

log = logging.getLogger("desk_agents.access_controller")

LEVER_PRODUCT = {"withdrawals": "CUSTODY", "trading": "TRADING", "api": "API", "financing": "FINANCING"}
IN_FLIGHT = {"PROPOSED", "NEEDS_INFO", "APPROVED"}
OUR_KINDS = {"RESTRICTION", "RESTORE", "CUSTODY_DEBIT", "REMINDER", "NOVEL_CASE"}
NEVER_PROPOSED = {"FEE_DEBIT", "FULL_FREEZE"}
DETAIL_STEP = {
    "Prepay required": "REQUIRE_PREPAY",
    "Read-only": "READ_ONLY",
    "OTC paused": "PAUSE_OTC",
    "Close-only": "CLOSE_ONLY",
    "No new borrowing": "NO_NEW_BORROWING",
    "Credit line lowered": "LOWER_LINE",
}
STEP_WORDS = {
    "REQUIRE_PREPAY": "required prepayment for new API usage",
    "RATE_LIMIT": "rate-limited API access",
    "READ_ONLY": "set API access to read-only",
    "PAUSE_OTC": "paused OTC trading",
    "NO_NEW_POSITIONS": "stopped new positions (you can still close or hedge existing ones)",
    "CLOSE_ONLY": "set trading to close-only",
    "NO_NEW_BORROWING": "paused new borrowing",
    "LOWER_LINE": "lowered your credit line",
    "HOLD_AMOUNT_OWED": "placed a hold on withdrawals equal to the amount past due",
}


@dataclass
class Move:
    """One reducer call the controller wants to make, with the reasoning it will cite."""

    action: str
    client_id: str
    args: dict[str, Any]
    summary: str


class AccessController(Agent):
    """Recover first, restrict the unpaid product first, gentlest step first; restore on payment."""

    name = "access-controller"

    async def run(self) -> list[Proposal]:
        world = load_world(self.db)
        for move in plan(world):
            self.execute(move)
        return []

    def execute(self, move: Move) -> None:
        call = getattr(self.db, move.action)
        try:
            call(move.client_id, **move.args)
            log.info("[%s] %s %s: %s", self.name, move.action, move.client_id, move.summary)
        except ReducerError as e:
            log.warning("[%s] %s %s refused: %s", self.name, move.action, move.client_id, e)


def plan(world: World, escalation_days: int | None = None) -> list[Move]:
    days = settings.escalation_days if escalation_days is None else escalation_days
    ladder = ladders(world.capability)
    moves = []
    for view in world.clients.values():
        move = next_move(view, world, ladder, days)
        if move:
            moves.append(move)
    return moves


def next_move(view: ClientView, world: World, ladder: dict[str, list[str]], escalation_days: int) -> Move | None:
    if any(w["kind"] in OUR_KINDS and w["state"] in IN_FLIGHT for w in view.work_item):
        return None
    today = world.today

    notice = notice_owed(view, world)
    if notice:
        return notice

    waiting = bool(view.in_transit) or open_promise(view)
    overdue = overdue_invoices(view, today)
    if overdue and not waiting and rejected_since(view, overdue[0]["due_on"], "CUSTODY_DEBIT") is None:
        debit = custody_debit(view, today, world.platform["auto_apply_limit_cents"])
        if debit:
            return debit

    defaulted = defaulted_invoices(view, today)
    if not defaulted:
        return restore(view)
    if waiting:
        return None

    episode = episode_start(view, defaulted)
    if cure_blocks(view) or rejected_since(view, episode, "RESTRICTION") is not None:
        return None
    return restriction(view, today, ladder, escalation_days)


def overdue_invoices(view: ClientView, today: str) -> list[Row]:
    return sorted(
        (i for i in view.invoice if i["due_on"] < today and i["status"] != "disputed" and i["paid_cents"] < i["amount_cents"]),
        key=lambda i: (i["due_on"], i["id"]),
    )


def defaulted_invoices(view: ClientView, today: str) -> list[Row]:
    grace = view.contract["grace_days"] if view.contract else 0
    disputed = {d["invoice_id"] for d in view.dispute if d["status"] != "resolved" and d["opened_on"] <= today}
    return [
        i for i in view.invoice
        if i["paid_cents"] < i["amount_cents"] and add_days(i["due_on"], grace) < today and i["id"] not in disputed
    ]


def owed(invoices: list[Row]) -> int:
    return sum(i["amount_cents"] - i["paid_cents"] for i in invoices)


def clause(view: ClientView, kind: str) -> Row | None:
    return next((c for c in view.contract_clause if c["kind"] == kind), None)


def allowed(view: ClientView, kind: str) -> bool:
    c = clause(view, kind)
    return bool(c and c["allowed"])


def latest_deadline(view: ClientView, kind: str) -> Row | None:
    rows = [d for d in view.deadline if d["kind"] == kind]
    return max(rows, key=lambda d: d["id"]) if rows else None


def open_promise(view: ClientView) -> bool:
    return any(d["kind"] == "promise_to_pay" and d["status"] == "open" for d in view.deadline)


def cure_blocks(view: ClientView) -> bool:
    if not allowed(view, "cure"):
        return False
    cure = latest_deadline(view, "cure_period")
    return not cure or cure["status"] != "expired"


def episode_start(view: ClientView, defaulted: list[Row]) -> str:
    cure = latest_deadline(view, "cure_period")
    if cure and cure["status"] in ("open", "expired"):
        return cure["started_on"]
    grace = view.contract["grace_days"] if view.contract else 0
    return min(add_days(i["due_on"], grace + 1) for i in defaulted)


def escalation_clock(view: ClientView, defaulted: list[Row]) -> str:
    cure = latest_deadline(view, "cure_period")
    if allowed(view, "cure") and cure:
        return cure["due_on"]
    return episode_start(view, defaulted)


def rejected_since(view: ClientView, since: str, kind: str) -> Row | None:
    return next((r for r in view.rejections if r["sim_date"] >= since and r["work_item_kind"] == kind), None)


def ladders(capability: list[Row]) -> dict[str, list[str]]:
    out: dict[str, list[Row]] = {}
    for c in capability:
        out.setdefault(c["lever"], []).append(c)
    return {lever: [c["step"] for c in sorted(rows, key=lambda c: c["gentleness"])] for lever, rows in out.items()}


def current_step(view: ClientView, lever: Row) -> str | None:
    if lever["state"] in ("active", "not_used"):
        return None
    item = next((w for w in view.work_item if w["id"] == lever.get("work_item_id")), None)
    if item and item["kind"] == "RESTRICTION":
        return json.loads(item["proposal_json"]).get("step")
    if lever["lever"] == "withdrawals":
        return "HOLD_AMOUNT_OWED"
    detail = lever["detail"]
    if detail.startswith("Rate limited"):
        return "RATE_LIMIT"
    if detail.startswith("No new positions"):
        return "NO_NEW_POSITIONS"
    return DETAIL_STEP.get(detail, detail)


def hedged(view: ClientView) -> bool:
    return any(p["status"] == "open" and p.get("hedge_group") for p in view.position)


def usable_steps(view: ClientView, lever: str, ladder: dict[str, list[str]]) -> list[str]:
    steps = [s for s in ladder.get(lever, []) if s not in NEVER_PROPOSED]
    if lever == "trading" and hedged(view):
        steps = [s for s in steps if s != "CLOSE_ONLY"]
    return steps


def restriction(view: ClientView, today: str, ladder: dict[str, list[str]], escalation_days: int) -> Move | None:
    overdue = overdue_invoices(view, today)
    if not overdue:
        return None
    unpaid = {i["product"] for i in overdue}
    cross = bool(view.contract and view.contract["cross_default"])
    flagged = any(f["status"] == "open" and f["pattern"] == "withdrawal_during_cure" for f in view.exploit_flag)

    candidates = []
    rungs_in_place = 0
    for lever in view.access_lever:
        name = lever["lever"]
        if lever["state"] == "not_used" or name not in LEVER_PRODUCT:
            continue
        steps = usable_steps(view, name, ladder)
        step = current_step(view, lever)
        position = steps.index(step) + 1 if step in steps else (len(steps) if step else 0)
        rungs_in_place += position
        if position >= len(steps):
            continue
        if name == "withdrawals":
            if not allowed(view, "set_off"):
                continue
            group = -1 if flagged else 1
        elif LEVER_PRODUCT[name] in unpaid:
            group = 0
        elif cross:
            group = 2
        else:
            continue
        candidates.append((group == 2, position, group, name, steps[position]))

    if not candidates:
        return None
    defaulted = defaulted_invoices(view, today)
    ready_on = escalation_clock(view, defaulted)
    if rungs_in_place:
        episode = episode_start(view, defaulted)
        approved = [a["sim_date"] for a in view.approvals if a["work_item_kind"] == "RESTRICTION" and a["sim_date"] >= episode]
        ready_on = add_days(max([ready_on, *approved]), escalation_days)
    if today < ready_on:
        return None

    *_, lever, step = min(candidates)
    amount = owed(overdue)
    name = view.client["name"]
    why = [f"{usd(amount)} past due on {', '.join(i['id'] for i in overdue)} ({', '.join(sorted(unpaid))})."]
    cure = latest_deadline(view, "cure_period")
    if cure and cure["status"] == "expired":
        why.append(f"Default notice of {cure['started_on']}; the cure period ended {cure['due_on']} unpaid (§9.1).")
    if rungs_in_place:
        why.append(f"The last restriction has been in place {escalation_days}+ days without payment.")
    if lever == "withdrawals":
        why.append("Hold only the undisputed amount owed under the set-off clause; the rest of custody stays withdrawable.")
        if flagged:
            why.append("The client withdrew custody cash during its cure period (exploit flag), so secure the balance first.")
    elif LEVER_PRODUCT[lever] not in unpaid:
        why.append(f"Nothing is overdue on {lever}; the contract's cross-default clause allows restricting it.")
    else:
        why.append(f"{lever} is the product that is unpaid; {step} is the gentlest step not yet taken.")
    if lever == "trading" and hedged(view):
        why.append("Open hedged positions: never close-only (pol-008); existing hedges stay intact.")
    return Move(
        action="propose_restriction",
        client_id=view.id,
        args={"lever": lever, "step": step, "reasoning": " ".join(why), "policy_ref": "pol-006",
              "confidence": 0.75 if LEVER_PRODUCT[lever] not in unpaid and lever != "withdrawals" else 0.9},
        summary=f"{step} on {name}'s {lever}",
    )


def fill(invoices: list[Row], budget: int) -> list[Row]:
    chosen, total = [], 0
    for inv in invoices:
        due = inv["amount_cents"] - inv["paid_cents"]
        if total + due <= budget:
            chosen.append(inv)
            total += due
    return chosen


def custody_debit(view: ClientView, today: str, auto_limit: int) -> Move | None:
    if not allowed(view, "debit"):
        return None
    overdue = overdue_invoices(view, today)
    cash = next((h["value_cents"] for h in view.custody_holding if h["asset"] == "USD"), 0)
    auto_eligible = view.client["tier"] > 1 and not view.client["strategic"]
    chosen = (fill(overdue, min(cash, auto_limit)) if auto_eligible else []) or fill(overdue, cash)
    if not chosen:
        return None
    ids = [i["id"] for i in chosen]
    total = owed(chosen)
    reasoning = (
        f"{usd(total)} past due on {', '.join(ids)}. Contract §{clause(view, 'debit')['clause']} allows debiting fees "
        f"from custody, and USD custody of {usd(cash)} covers it. Collecting first avoids any restriction."
    )
    if len(chosen) < len(overdue):
        reasoning += (
            f" This covers {len(chosen)} of {len(overdue)} overdue invoices"
            f"{' (the part within the auto-apply limit)' if total <= auto_limit < owed(overdue) else ''}; the rest follows separately."
        )
    return Move(
        action="propose_custody_debit",
        client_id=view.id,
        args={"invoice_ids": ids, "reasoning": reasoning, "policy_ref": "pol-005", "confidence": 0.9},
        summary=f"debit {usd(total)} from {view.client['name']}'s custody",
    )


def restore(view: ClientView) -> Move | None:
    for lever in view.access_lever:
        if lever["state"] in ("limited", "off"):
            if lever["lever"] == "withdrawals" and any(h["status"] == "active" for h in view.hold):
                continue
            return Move(
                action="propose_restore",
                client_id=view.id,
                args={"lever": lever["lever"], "policy_ref": "pol-011", "confidence": 0.95,
                      "reasoning": f"Nothing is in default any more; {lever['lever']} ({lever['detail']}) goes back to normal."},
                summary=f"restore {view.client['name']}'s {lever['lever']}",
            )
    return None


def notice_owed(view: ClientView, world: World) -> Move | None:
    sent = " ".join(w["proposal_json"] for w in view.work_item if w["kind"] == "REMINDER")
    for item in view.work_item:
        if item["kind"] not in ("RESTRICTION", "RESTORE") or item["state"] != "POSTED":
            continue
        ref = f"(ref WI-{item['id']})"
        if ref in sent:
            continue
        return Move(
            action="propose_notice",
            client_id=view.id,
            args={"channel": "email", "body": notice_body(view, item, world, ref), "policy_ref": "pol-007",
                  "confidence": 0.95, "reasoning": f"Tell the client what changed on WI-{item['id']}, why, and how to restore it."},
            summary=f"notice to {view.client['name']} about WI-{item['id']}",
        )
    return None


def notice_body(view: ClientView, item: Row, world: World, ref: str) -> str:
    p = json.loads(item["proposal_json"])
    lever = p.get("lever", "")
    if item["kind"] == "RESTORE":
        return f"Payment received: your {lever} access is fully restored. Thank you. {ref}"
    overdue = overdue_invoices(view, world.today)
    action = STEP_WORDS.get(p.get("step", ""), f"restricted {lever}")
    return (
        f"We have {action} because {usd(owed(overdue))} is past due ({', '.join(i['id'] for i in overdue)}). "
        "Everything else on your account is unchanged. To restore access, pay the amount past due: "
        f"{world.platform['wire_instructions']}. Access is restored automatically once payment posts. {ref}"
    )


def add_days(iso: str, days: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()


def usd(cents: int) -> str:
    return f"${cents / 100:,.2f}"
