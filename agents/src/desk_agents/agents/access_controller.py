import json
import logging
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import httpx

from ..config import settings
from ..models import Proposal, WorkItemKind
from ..pushback import Reader, RmReading
from ..stdb import ReducerError
from ..world import ClientView, Row, World, load_world
from .base import Agent

log = logging.getLogger("desk_agents.access_controller")

LEVER_PRODUCT = {"withdrawals": "CUSTODY", "trading": "TRADING", "api": "API", "financing": "FINANCING"}
OPEN = {"PROPOSED", "NEEDS_INFO"}
EXECUTED_KINDS = {"RESTRICTION", "RESTORE", "CUSTODY_DEBIT", "REMINDER"}
OUR_KINDS = EXECUTED_KINDS | {"NOVEL_CASE"}
LEARN_FROM = {"RESTRICTION", "CUSTODY_DEBIT", "NOVEL_CASE"}
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
    """One SpacetimeClient call the controller wants to make, with the reasoning it will cite."""

    action: str
    client_id: str
    args: dict[str, Any]
    summary: str


@dataclass
class Wait:
    """A deliberate decision not to act on a client who owes money, and why."""

    code: str
    reason: str


class AccessController(Agent):
    """Recover first, restrict the unpaid product first, gentlest step first; restore on payment."""

    name = "access-controller"

    def __init__(self, db, reader: Reader | None = None):
        super().__init__(db)
        self.reader = reader or Reader()
        self.readings: dict[int, RmReading] = {}
        self.unavailable: set[str] = set()
        self.acted = 0

    async def run(self) -> list[Proposal]:
        world = self.observe()
        self.acted = sum(self.execute(move) for move in plan(world))
        return []

    def observe(self) -> World:
        world = load_world(self.db)
        for view in world.clients.values():
            for note in view.rm_note:
                if note["id"] not in self.readings and not answered(view, note["id"]):
                    self.readings[note["id"]] = self.reader.read(note["text"], view.client["name"], world.today)
        world.readings = self.readings
        return world

    def execute(self, move: Move) -> bool:
        if move.action in self.unavailable:
            return False
        try:
            getattr(self.db, move.action)(**move.args)
            log.info("[%s] %s %s: %s", self.name, move.action, move.client_id, move.summary)
            return True
        except ReducerError as e:
            log.warning("[%s] %s %s refused: %s", self.name, move.action, move.client_id, e)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                self.unavailable.add(move.action)
                log.warning("[%s] %s is not published in this database yet; skipping it", self.name, move.action)
            else:
                log.warning("[%s] %s %s failed: %s", self.name, move.action, move.client_id, e)
        return False


def plan(world: World, escalation_days: int | None = None) -> list[Move]:
    days = settings.escalation_days if escalation_days is None else escalation_days
    ladder = ladders(world.capability)
    moves = []
    for view in world.clients.values():
        moves += precedents_due(view, world) + investigations_due(view, world)
        decision = next_move(view, world, ladder, days)
        if isinstance(decision, Move):
            moves.append(decision)
        elif isinstance(decision, Wait) and world.last_waits.get(view.id) != decision.reason:
            moves.append(Move(action="record_wait", client_id=view.id,
                              args={"client_id": view.id, "code": decision.code, "reason": decision.reason},
                              summary=f"waited ({decision.code}): {decision.reason}"))
    return moves


def next_move(
    view: ClientView, world: World, ladder: dict[str, list[str]], escalation_days: int,
) -> Move | Wait | None:
    today = world.today
    overdue = overdue_invoices(view, today)
    pending = open_work(view)
    if pending:
        return Wait("pending_decision", pending) if overdue else None

    reply = rm_reply(view, world)
    if reply:
        return reply

    notice = notice_owed(view, world)
    if notice:
        return notice

    hold_off = waiting(view, today, escalation_days)
    debit_rejected = overdue and rejected_since(view, overdue[0]["due_on"], "CUSTODY_DEBIT")
    if overdue and not hold_off and not debit_rejected:
        debit = custody_debit(view, today, world.platform["auto_apply_limit_cents"])
        if debit:
            return debit

    defaulted = defaulted_invoices(view, today)
    if not defaulted:
        restored = restore(view)
        if restored or not overdue:
            return restored
        grace = view.contract["grace_days"] if view.contract else 0
        return Wait("grace_period", f"{usd(owed(overdue))} overdue on {ids(overdue)} but inside the {grace}-day grace period "
                                    f"(in default from {add_days(overdue[0]['due_on'], grace + 1)}). {no_debit(view, today)}")
    if hold_off:
        return hold_off

    episode = episode_start(view, defaulted)
    cure = latest_deadline(view, "cure_period")
    if cure_blocks(view):
        if cure and cure["status"] == "open":
            return Wait("cure_period", f"{usd(owed(defaulted))} in default, but the cure period{cite(view, 'cure')} runs until {cure['due_on']} "
                                       f"after the default notice of {cure['started_on']}; restricting before then breaches the contract.")
        return Wait("awaiting_default_notice", f"{usd(owed(defaulted))} in default on {ids(defaulted)}; no default notice has "
                                               f"gone out yet, so the cure period{cite(view, 'cure')} has not started (pol-007 sends it).")
    rejected = rejected_since(view, episode, "RESTRICTION")
    if rejected:
        note = f": \u201c{rejected['detail']}\u201d" if rejected.get("detail") else ""
        return Wait("controller_rejected", f"A controller rejected a restriction on {rejected['sim_date']}{note}. "
                                           "Not escalating again until the client cures.")
    return restriction(view, today, ladder, escalation_days, only_levers=agreed_levers(view))


def open_work(view: ClientView) -> str | None:
    for w in sorted(view.work_item, key=lambda w: w["id"]):
        if w["kind"] not in OUR_KINDS:
            continue
        if w["state"] in OPEN:
            return f"{w['kind'].replace('_', ' ').lower()} WI-{w['id']} is waiting for a {w['required_role'].lower()}: {w['title']}."
        if w["state"] == "APPROVED" and w["kind"] in EXECUTED_KINDS:
            return f"WI-{w['id']} ({w['title']}) is approved and executing through the gateway."
    return None


def busy(view: ClientView) -> bool:
    return open_work(view) is not None


def waiting(view: ClientView, today: str, escalation_days: int) -> Wait | None:
    if view.in_transit:
        m = view.in_transit[0]
        return Wait("payment_in_transit", f"{usd(m['amount_cents'])} {m['rail']} {m['bank_ref']} from {m['orig_name']} was sent "
                                          f"{m['value_on']} and has not posted; acting only on posted funds.")
    promise = next((d for d in view.deadline if d["kind"] == "promise_to_pay" and d["status"] == "open"), None)
    if promise:
        note = f" ({promise['note']})" if promise.get("note") else ""
        return Wait("promise_to_pay", f"Promise to pay by {promise['due_on']}{note}.")
    until = grace_until(view, today, escalation_days)
    if until:
        return Wait("approved_exception", f"A controller approved an exception; holding off until {until}.")
    return None


def no_debit(view: ClientView, today: str) -> str:
    if not allowed(view, "debit"):
        return f"Custody can't be debited without the client's consent{cite(view, 'debit')}."
    cash = next((h["value_cents"] for h in view.custody_holding if h["asset"] == "USD"), 0)
    return f"USD custody of {usd(cash)} doesn't cover any overdue invoice."


def ids(invoices: list[Row]) -> str:
    return ", ".join(i["id"] for i in invoices)


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


def cite(view: ClientView, kind: str) -> str:
    c = clause(view, kind)
    return f" (§{c['clause']})" if c else ""


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


def restriction(
    view: ClientView, today: str, ladder: dict[str, list[str]], escalation_days: int, only_levers: set[str] | None = None,
) -> Move | Wait | None:
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
        if position >= len(steps) or (only_levers is not None and name not in only_levers):
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
        if only_levers is not None:
            why = f"the controller-approved plan limits restrictions to {', '.join(sorted(only_levers))}, already in place"
        elif rungs_in_place:
            why = "every step the contract and policy allow is already in place"
        else:
            why = "the contract gives no lever for the unpaid products (no set-off right, no cross-default)"
        return Wait("no_further_step", f"{usd(owed(overdue))} still past due, but {why}; escalating needs a person.")
    defaulted = defaulted_invoices(view, today)
    ready_on = escalation_clock(view, defaulted)
    if rungs_in_place:
        episode = episode_start(view, defaulted)
        approved = [a["sim_date"] for a in view.approvals if a["work_item_kind"] == "RESTRICTION" and a["sim_date"] >= episode]
        ready_on = add_days(max([ready_on, *approved]), escalation_days)
    if today < ready_on:
        return Wait("escalation_spacing", f"A restriction is in place; the next step waits until {ready_on} "
                                          f"({escalation_days} days after the last one, giving the client time to pay).")

    *_, lever, step = min(candidates)
    amount = owed(overdue)
    name = view.client["name"]
    why = [f"{usd(amount)} past due on {', '.join(i['id'] for i in overdue)} ({', '.join(sorted(unpaid))})."]
    cure = latest_deadline(view, "cure_period")
    if cure and cure["status"] == "expired":
        why.append(f"Default notice of {cure['started_on']}; the cure period ended {cure['due_on']} unpaid{cite(view, 'cure')}.")
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
        args={"client_id": view.id, "lever": lever, "step": step, "reasoning": " ".join(why), "policy_ref": "pol-006",
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
        args={"client_id": view.id, "invoice_ids": ids, "reasoning": reasoning, "policy_ref": "pol-005", "confidence": 0.9},
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
                args={"client_id": view.id, "lever": lever["lever"], "policy_ref": "pol-011", "confidence": 0.95,
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
            args={"client_id": view.id, "channel": "email", "body": notice_body(view, item, world, ref), "policy_ref": "pol-007",
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


def note_tag(note_id: int) -> str:
    return f"(re RM-{note_id})"


def answered(view: ClientView, note_id: int) -> bool:
    tag = note_tag(note_id)
    return any(
        w["subject_id"] == f"rm_note:{note_id}" or (w["kind"] == "REMINDER" and tag in w["proposal_json"])
        for w in view.work_item
    )


def rm_reply(view: ClientView, world: World) -> Move | None:
    for note in sorted(view.rm_note, key=lambda n: n["id"]):
        reading = world.readings.get(note["id"])
        if reading is None or answered(view, note["id"]):
            continue
        if reading.intent == "already_paid":
            return payment_check(view, note, reading, world)
        if reading.intent == "material_event":
            return material_event_case(view, note, reading, world)
        if reading.intent == "exception_request":
            return exception_case(view, note, reading, world)
    return None


def payment_check(view: ClientView, note: Row, reading: RmReading, world: World) -> Move:
    today = world.today
    name = view.client["name"]
    defaulted = defaulted_invoices(view, today)
    owing = owed(defaulted)
    since = min((i["due_on"] for i in defaulted), default=today)
    recent = [m for m in view.cash if m["value_on"] >= since]
    quoted = (reading.payment_reference or "").upper()
    cited = [m for m in recent if quoted and (quoted in m["bank_ref"].upper() or quoted in m["memo"].upper())]

    if not defaulted:
        finding = f"Confirmed: nothing from {name} is past due any more. Any restriction is being lifted."
    elif view.in_transit:
        m = view.in_transit[0]
        finding = (
            f"We see {usd(m['amount_cents'])} {m['rail']} {m['bank_ref']} from {m['orig_name']} sent {m['value_on']}, "
            f"not yet posted. No further restriction while it is in transit; access is restored automatically when it posts."
        )
    elif unmatched := [m for m in recent if m["status"] == "posted" and m["match_status"] not in ("matched", "in_transit")]:
        m = unmatched[0]
        finding = (
            f"{usd(m['amount_cents'])} {m['bank_ref']} from {m['orig_name']} arrived {m['value_on']} but could not be matched "
            f"to invoices automatically; an accountant is reviewing it. Access is restored as soon as it is applied."
        )
    else:
        applied = sum(m["amount_cents"] for m in recent if m["match_status"] == "matched")
        claimed = f" {usd(int(reading.claimed_amount_usd * 100))} payment" if reading.claimed_amount_usd else " payment"
        finding = (
            f"No{claimed} from {name} has reached our bank feed since {since}"
            f"{f' (reference {reading.payment_reference} not found)' if reading.payment_reference and not cited else ''}. "
            f"{f'{usd(applied)} was received and applied; ' if applied else ''}{usd(owing)} is still past due "
            f"({', '.join(i['id'] for i in defaulted)}). Restrictions stay as they are. Please ask the client for the "
            "Fed IMAD or MT103 so we can trace the wire."
        )
    return Move(
        action="propose_notice",
        client_id=view.id,
        args={"client_id": view.id, "channel": "rm", "body": f"{finding} {note_tag(note['id'])}", "policy_ref": "pol-007",
              "confidence": 0.9, "reasoning": f"RM {note['author']} says {name} already paid; checked the bank feed before acting."},
        summary=f"reply to {note['author']} on {name}'s payment",
    )


def exception_case(view: ClientView, note: Row, reading: RmReading, world: World) -> Move:
    today = world.today
    name = view.client["name"]
    defaulted = defaulted_invoices(view, today)
    restricted = [f"{lever['lever']} ({lever['detail']})" for lever in view.access_lever if lever["state"] in ("limited", "off")]
    past = [p for p in view.precedent if p["decision"]]
    facts = [
        f"{usd(owed(defaulted))} past due on {', '.join(i['id'] for i in defaulted)}." if defaulted else "Nothing is in default today.",
        f"Restricted now: {', '.join(restricted)}." if restricted else "No restrictions in place.",
        f"Tier {view.client['tier']}{', strategic' if view.client['strategic'] else ''}; RM {view.client['relationship_manager']}.",
    ]
    if past:
        facts.append("Precedents: " + "; ".join(f"{p['decided_on']} {p['decision']} → {p['outcome']}" for p in past[-3:]) + ".")
    facts.append("The agent cannot grant exceptions; a controller decides. Escalation is paused while this is open.")
    proposal = Proposal(
        kind=WorkItemKind.NOVEL_CASE,
        client_id=view.id,
        subject_id=f"rm_note:{note['id']}",
        title=f"{note['author']} asks to hold off on {name}",
        amount_cents=owed(defaulted),
        proposal={"rmNoteId": note["id"], "request": note["text"], "graceUntil": reading.grace_until,
                  "reason": reading.reason, "summary": reading.summary},
        reasoning=" ".join(facts),
        policy_ref="pol-006",
        confidence=0.5,
    )
    return Move(action="propose", client_id=view.id, args={"p": proposal}, summary=proposal.title)


EVENT_WORDS = {
    "acquisition": "being acquired", "merger": "merging", "insolvency": "insolvent", "wind_down": "winding down",
    "regulatory": "under regulatory action", "other": "going through a material change",
}


def material_event_case(view: ClientView, note: Row, reading: RmReading, world: World) -> Move:
    today = world.today
    name = view.client["name"]
    event = reading.event_type or "other"
    who = f" by {reading.counterparty}" if reading.counterparty and event in ("acquisition", "merger") else ""
    when = reading.effective_date
    defaulted = defaulted_invoices(view, today)
    open_invoices = [i for i in view.invoice if i["paid_cents"] < i["amount_cents"] and i["status"] != "disputed"]
    in_default, total_open = owed(defaulted), owed(open_invoices)
    usd_cash = next((h["value_cents"] for h in view.custody_holding if h["asset"] == "USD"), 0)
    custody = sum(h["value_cents"] for h in view.custody_holding)
    coc, set_off, debit = clause(view, "change_of_control"), clause(view, "set_off"), clause(view, "debit")
    cure = latest_deadline(view, "cure_period")
    since = min((i["due_on"] for i in defaulted), default=today)
    withdrawn = sum(r["allowed_cents"] for r in view.access_request if r["action"] == "withdraw" and r["decision"] != "denied")
    flagged = [f for f in view.exploit_flag if f["status"] == "open"]
    covering = [p["policy_id"] for p in world.policies if re.search(r"change of control|acqui|merger|insolv", p["title"] + p["rule_json"], re.IGNORECASE)]

    steps = [
        ("rm_note", f"{note['author']}: {name} is {EVENT_WORDS[event]}{who}{f', effective {when}' if when else ''}."),
        ("policy_search", f"Covered by {', '.join(covering)}." if covering else
         f"None of the {len(world.policies)} active policies covers a change of control: this needs a controller."),
        ("contract", "; ".join(filter(None, [
            f"§{coc['clause']}: {coc['text'].rstrip('.')}" if coc and coc["allowed"] else "No change-of-control clause",
            f"§{set_off['clause']} set-off allowed" if set_off and set_off["allowed"] else "no set-off right",
            "custody debits allowed" if debit and debit["allowed"] else f"debits need written consent{cite(view, 'debit')}",
            f"cure period {cure['status']} until {cure['due_on']}" if cure and cure["status"] in ("open", "expired") else None,
        ])) + "."),
        ("exposure", (f"{usd(in_default)} in default, {usd(total_open)} open in total; custody holds {usd(usd_cash)} USD "
                     f"of {usd(custody)} overall.")),
        ("custody_activity", (f"{usd(withdrawn)} withdrawn from custody" if withdrawn else "No withdrawals")
         + f" since {since}" + (f"; open flags: {', '.join(f['pattern'] for f in flagged)}" if flagged else "") + "."),
    ]
    past = [p for p in view.precedent if p["decision"]]
    if past:
        steps.append(("precedents", "; ".join(f"{p['decided_on']} {p['proposed']} → {p['decision']} ({p['outcome']})" for p in past[-3:])))

    plan_steps = []
    if coc and coc["allowed"]:
        plan_steps.append(f"Invoke §{coc['clause']}: all {usd(total_open)} open becomes payable at closing"
                          f"{f' on {when}' if when else ''}; send the acquirer a payoff statement.")
    if cure and cure["status"] == "open":
        plan_steps.append(f"No restriction before the cure period ends {cure['due_on']} (§{clause(view, 'cure')['clause']}).")
    running = [{"api": "API access"}.get(lever["lever"], lever["lever"]) for lever in view.access_lever if lever["lever"] != "withdrawals" and lever["state"] != "not_used"]
    if set_off and set_off["allowed"] and in_default:
        plan_steps.append(f"If still unpaid then, hold {usd(in_default)} of withdrawals under §{set_off['clause']}; "
                          f"keep {' and '.join(running) or 'everything else'} running so the deal is not disrupted.")
    if not (debit and debit["allowed"]):
        plan_steps.append("Ask the RM for written consent to debit custody, which would settle it today.")
    if usd_cash < total_open or flagged:
        plan_steps.append("Custody cash is moving out: secure the balance before closing rather than after.")
    plan_steps.append(f"Ask {note['author']} for the closing date, the acquirer's legal entity and whether the MSA is assigned.")
    steps.append(("proposal", " ".join(plan_steps)))

    proposal = Proposal(
        kind=WorkItemKind.NOVEL_CASE,
        client_id=view.id,
        subject_id=f"rm_note:{note['id']}",
        title=f"{name} is {EVENT_WORDS[event]}{who}: no policy covers it",
        amount_cents=total_open,
        proposal={"rmNoteId": note["id"], "event": event, "counterparty": reading.counterparty, "effectiveDate": when,
                  "onlyLevers": ["withdrawals"], "investigation": [{"tool": t, "summary": x} for t, x in steps]},
        reasoning=" ".join(plan_steps),
        policy_ref="none",
        clauses_cited=[c["clause"] for c in (coc, set_off) if c and c["allowed"]],
        confidence=0.6,
    )
    return Move(action="propose", client_id=view.id, args={"p": proposal}, summary=proposal.title)


def agreed_levers(view: ClientView) -> set[str] | None:
    approved = {a["work_item_id"] for a in view.approvals}
    for item in view.work_item:
        if item["kind"] == "NOVEL_CASE" and item["id"] in approved:
            levers = json.loads(item["proposal_json"]).get("onlyLevers")
            if levers is not None:
                return set(levers)
    return None


def investigations_due(view: ClientView, world: World) -> list[Move]:
    moves = []
    for item in view.work_item:
        if item["kind"] != "NOVEL_CASE" or item["id"] in world.investigated:
            continue
        steps = json.loads(item["proposal_json"]).get("investigation")
        if steps:
            rows = [{"tool": s["tool"], "summary": s["summary"], "status": "done"} for s in steps]
            moves.append(Move(action="record_investigation", client_id=view.id,
                              args={"work_item_id": item["id"], "steps": rows},
                              summary=f"{len(rows)} investigation steps on WI-{item['id']}"))
    return moves


def grace_until(view: ClientView, today: str, escalation_days: int) -> str | None:
    approved_on = {a["work_item_id"]: a["sim_date"] for a in view.approvals}
    for item in view.work_item:
        if item["kind"] != "NOVEL_CASE" or not item["subject_id"].startswith("rm_note:") or item["id"] not in approved_on:
            continue
        until = json.loads(item["proposal_json"]).get("graceUntil") or add_days(approved_on[item["id"]], escalation_days)
        if until >= today:
            return until
    return None


def precedents_due(view: ClientView, world: World) -> list[Move]:
    known = {p["id"]: p for p in view.precedent}
    in_default = bool(defaulted_invoices(view, world.today))
    moves = []
    for event in view.rejections + view.approvals:
        item = world.work_items.get(event["work_item_id"])
        if not item or item["kind"] not in LEARN_FROM:
            continue
        if item["kind"] != "NOVEL_CASE" and event["to_state"] == "APPROVED":
            continue
        pid = f"PRC-L-{item['id']}"
        existing = known.get(pid)
        if existing and (existing["outcome"] != "pending" or in_default):
            continue
        outcome = "pending" if in_default else f"Cured by {world.today}"
        decision = "Approved" if event["to_state"] == "APPROVED" else "Rejected"
        row = {
            "id": pid, "client_id": view.id, "work_item_id": {"some": item["id"]}, "decided_on": event["sim_date"],
            "situation": item["reasoning"][:500], "proposed": item["title"], "decision": decision,
            "override_reason": event["detail"] if decision == "Rejected" else "", "outcome": outcome,
            "policy_ref": item["policy_ref"], "source": "live",
        }
        if existing:
            row = {**existing, "work_item_id": {"some": item["id"]}, "outcome": outcome}
        moves.append(Move(action="upsert_precedent", client_id=view.id, args={"row": row},
                          summary=f"{'update' if existing else 'record'} precedent {pid}: {decision.lower()} · {outcome}"))
    return moves


def add_days(iso: str, days: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()


def usd(cents: int) -> str:
    return f"${cents / 100:,.2f}"
