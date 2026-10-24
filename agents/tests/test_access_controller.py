import json
import unittest

from desk_agents.agents.access_controller import plan
from desk_agents.pushback import RmReading
from desk_agents.world import ClientView, World

TODAY = "2026-03-20"
LADDER = {
    "api": ["REQUIRE_PREPAY", "RATE_LIMIT", "READ_ONLY"],
    "trading": ["PAUSE_OTC", "NO_NEW_POSITIONS", "CLOSE_ONLY"],
    "financing": ["NO_NEW_BORROWING", "LOWER_LINE"],
    "withdrawals": ["FEE_DEBIT", "HOLD_AMOUNT_OWED", "FULL_FREEZE"],
}


def capability():
    return [
        {"lever": lever, "step": step, "gentleness": i + 1}
        for lever, steps in LADDER.items()
        for i, step in enumerate(steps)
    ]


def view(products=("TRADING", "CUSTODY"), owed=(("INV-1", "TRADING", 50_000_00),), debit=False, set_off=True,
         cure="expired", cure_due="2026-03-01", tier=3, usd=0, levers=None, **extra):
    v = ClientView(
        client={"id": "ORG-1", "name": "Acme", "legal_name": "Acme LP", "tier": tier, "strategic": False,
                "relationship_manager": "Priya Nair"},
        contract={"grace_days": 10, "cure_days": 15, "cross_default": False},
        invoice=[
            {"id": i, "product": p, "due_on": "2026-02-01", "amount_cents": amt, "paid_cents": 0, "status": "open"}
            for i, p, amt in owed
        ],
        contract_clause=[
            {"kind": "set_off", "clause": "7.2", "allowed": set_off},
            {"kind": "debit", "clause": "6.3", "allowed": debit},
            {"kind": "cure", "clause": "9.1", "allowed": True},
        ],
        access_lever=levers if levers is not None else [
            {"lever": lever, "state": "active" if product in products else "not_used", "detail": "Normal", "work_item_id": None}
            for lever, product in [("withdrawals", "CUSTODY"), ("trading", "TRADING"), ("api", "API"), ("financing", "FINANCING")]
        ],
        custody_holding=[{"asset": "USD", "value_cents": usd}],
        deadline=[{"id": 1, "kind": "cure_period", "started_on": "2026-02-14", "due_on": cure_due, "status": cure}] if cure else [],
    )
    for key, value in extra.items():
        setattr(v, key, value)
    return v


def event(state, sim_date, item_id, kind="RESTRICTION", detail=""):
    return {"to_state": state, "sim_date": sim_date, "work_item_id": item_id, "work_item_kind": kind, "detail": detail}


def item(item_id, kind, state, proposal=None, subject="ORG-1", **extra):
    return {"id": item_id, "kind": kind, "state": state, "subject_id": subject, "proposal_json": json.dumps(proposal or {}),
            "title": f"{kind} {item_id}", "reasoning": "why", "policy_ref": "pol-006", **extra}


def world(v, today=TODAY, readings=None):
    return World(
        today=today,
        platform={"auto_apply_limit_cents": 50_000_00, "wire_instructions": "ACCT 1"},
        capability=capability(),
        clients={v.id: v},
        work_items={w["id"]: w for w in v.work_item},
        readings=readings or {},
    )


def moves(v, **kw):
    return plan(world(v, **kw), escalation_days=7)


def only(v, **kw):
    found = [m for m in moves(v, **kw) if m.action != "upsert_precedent"]
    return found[0] if found else None


class AccessControllerPlan(unittest.TestCase):
    def test_restricts_unpaid_product_gentlest_step_first(self):
        m = only(view())
        self.assertEqual((m.action, m.args["lever"], m.args["step"]), ("propose_restriction", "trading", "PAUSE_OTC"))

    def test_no_restriction_while_cure_period_runs(self):
        self.assertIsNone(only(view(cure="open")))

    def test_no_restriction_before_any_default_notice(self):
        self.assertIsNone(only(view(cure=None)))

    def test_collects_from_custody_before_restricting(self):
        m = only(view(debit=True, usd=1_000_000_00))
        self.assertEqual(m.action, "propose_custody_debit")

    def test_debit_splits_at_auto_apply_limit(self):
        v = view(debit=True, usd=1_000_000_00, owed=(("INV-1", "CUSTODY", 22_400_00), ("INV-2", "TRADING", 64_000_00)))
        self.assertEqual(only(v).args["invoice_ids"], ["INV-1"])

    def test_tier_one_debit_goes_whole_to_controller(self):
        v = view(tier=1, debit=True, usd=1_000_000_00, owed=(("INV-1", "CUSTODY", 22_400_00), ("INV-2", "TRADING", 64_000_00)))
        self.assertEqual(only(v).args["invoice_ids"], ["INV-1", "INV-2"])

    def test_waits_for_payment_in_transit(self):
        self.assertIsNone(only(view(in_transit=[{"id": "WIRE"}])))

    def test_waits_for_open_promise_to_pay(self):
        v = view()
        v.deadline.append({"id": 2, "kind": "promise_to_pay", "started_on": TODAY, "due_on": "2026-03-25", "status": "open"})
        self.assertIsNone(only(v))

    def test_one_step_at_a_time_with_escalation_cadence(self):
        levers = [
            {"lever": "withdrawals", "state": "active", "detail": "Normal", "work_item_id": None},
            {"lever": "trading", "state": "limited", "detail": "OTC paused", "work_item_id": None},
        ]
        self.assertIsNone(only(view(levers=levers, cure_due="2026-03-15")))
        m = only(view(levers=levers, cure_due="2026-03-01"))
        self.assertEqual((m.args["lever"], m.args["step"]), ("withdrawals", "HOLD_AMOUNT_OWED"))
        levers[0] = {"lever": "withdrawals", "state": "limited", "detail": "$500.00 held", "work_item_id": None}
        approved_late = [event("APPROVED", "2026-03-16", 5)]
        self.assertIsNone(only(view(levers=levers, cure_due="2026-03-01", approvals=approved_late)))
        approved = [event("APPROVED", "2026-03-12", 5)]
        m = only(view(levers=levers, cure_due="2026-03-01", approvals=approved))
        self.assertEqual((m.args["lever"], m.args["step"]), ("trading", "NO_NEW_POSITIONS"))

    def test_hedged_book_never_close_only(self):
        levers = [
            {"lever": "withdrawals", "state": "limited", "detail": "$500.00 held", "work_item_id": None},
            {"lever": "trading", "state": "limited", "detail": "No new positions · closing allowed", "work_item_id": None},
        ]
        position = [{"status": "open", "hedge_group": "H1"}]
        self.assertIsNone(only(view(levers=levers, cure_due="2026-01-01", position=position)))
        m = only(view(levers=levers, cure_due="2026-01-01"))
        self.assertEqual(m.args["step"], "CLOSE_ONLY")

    def test_hold_withdrawals_first_after_withdrawal_during_cure(self):
        flag = [{"status": "open", "pattern": "withdrawal_during_cure"}]
        m = only(view(exploit_flag=flag))
        self.assertEqual((m.args["lever"], m.args["step"]), ("withdrawals", "HOLD_AMOUNT_OWED"))

    def test_no_hold_without_set_off_right(self):
        m = only(view(products=("CUSTODY",), owed=(("INV-1", "CUSTODY", 100_00),), set_off=False))
        self.assertIsNone(m)

    def test_respects_controller_rejection(self):
        v = view(rejections=[event("REJECTED", "2026-03-10", 5)])
        self.assertIsNone(only(v))

    def test_ignores_rejection_from_earlier_episode(self):
        v = view(rejections=[event("REJECTED", "2025-11-10", 5)])
        self.assertEqual(only(v).action, "propose_restriction")

    def test_restores_once_nothing_in_default(self):
        levers = [{"lever": "trading", "state": "limited", "detail": "OTC paused", "work_item_id": None}]
        v = view(levers=levers, owed=())
        m = only(v)
        self.assertEqual((m.action, m.args["lever"]), ("propose_restore", "trading"))

    def test_disputed_invoice_is_not_in_default(self):
        v = view(dispute=[{"invoice_id": "INV-1", "status": "under_review", "opened_on": "2026-02-05"}])
        v.invoice[0]["status"] = "disputed"
        self.assertIsNone(only(v))

    def test_skips_client_with_work_in_flight(self):
        v = view(work_item=[item(9, "RESTRICTION", "PROPOSED")])
        self.assertIsNone(only(v))

    def test_tells_client_after_restriction_posts(self):
        posted = item(9, "RESTRICTION", "POSTED", {"lever": "trading", "step": "PAUSE_OTC"})
        m = only(view(work_item=[posted]))
        self.assertEqual(m.action, "propose_notice")
        self.assertIn("(ref WI-9)", m.args["body"])
        sent = item(10, "REMINDER", "POSTED", {"body": m.args["body"]})
        self.assertNotEqual(only(view(work_item=[posted, sent])).action, "propose_notice")


NOTE = {"id": 4, "client_id": "ORG-1", "author": "Priya Nair", "text": "...", "work_item_id": None}
PAID = RmReading(intent="already_paid", summary="wire sent", claimed_amount_usd=50_000.0, payment_reference="IMAD123456")
HOLD_OFF = RmReading(intent="exception_request", summary="hold off", grace_until="2026-03-31", reason="acquisition")


def wire(status="posted", match="matched", value_on="2026-03-02", amount=50_000_00):
    return {"amount_cents": amount, "rail": "WIRE", "bank_ref": "WI-1", "orig_name": "ACME LP", "value_on": value_on,
            "status": status, "match_status": match, "memo": ""}


class RmPushback(unittest.TestCase):
    def test_already_paid_checks_bank_feed_before_anything_else(self):
        m = only(view(rm_note=[NOTE]), readings={4: PAID})
        self.assertEqual((m.action, m.args["channel"]), ("propose_notice", "rm"))
        self.assertIn("No $50,000.00 payment from Acme has reached our bank feed", m.args["body"])
        self.assertIn("IMAD123456 not found", m.args["body"])
        self.assertIn("(re RM-4)", m.args["body"])

    def test_already_paid_finds_wire_in_transit(self):
        transit = wire(status="pending", match="in_transit")
        m = only(view(rm_note=[NOTE], cash=[transit], in_transit=[transit]), readings={4: PAID})
        self.assertIn("not yet posted", m.args["body"])

    def test_already_paid_finds_unmatched_cash(self):
        m = only(view(rm_note=[NOTE], cash=[wire(match="exception")]), readings={4: PAID})
        self.assertIn("could not be matched", m.args["body"])

    def test_answered_note_is_not_answered_again(self):
        reply = item(11, "REMINDER", "POSTED", {"body": "No payment (re RM-4)"})
        self.assertEqual(only(view(rm_note=[NOTE], work_item=[reply]), readings={4: PAID}).action, "propose_restriction")

    def test_exception_request_goes_to_controller_never_self_approved(self):
        m = only(view(rm_note=[NOTE]), readings={4: HOLD_OFF})
        self.assertEqual(m.action, "propose")
        p = m.args["p"]
        self.assertEqual((p.kind.value, p.subject_id, p.required_role.value), ("NOVEL_CASE", "rm_note:4", "CONTROLLER"))
        self.assertEqual(p.proposal["graceUntil"], "2026-03-31")

    def test_open_exception_pauses_escalation(self):
        case = item(12, "NOVEL_CASE", "PROPOSED", subject="rm_note:4")
        self.assertIsNone(only(view(rm_note=[NOTE], work_item=[case]), readings={4: HOLD_OFF}))

    def test_approved_exception_grants_grace_until_date(self):
        case = item(12, "NOVEL_CASE", "APPROVED", {"graceUntil": "2026-03-25"}, subject="rm_note:4")
        approvals = [event("APPROVED", "2026-03-18", 12, kind="NOVEL_CASE")]
        self.assertIsNone(only(view(rm_note=[NOTE], work_item=[case], approvals=approvals)))
        self.assertEqual(only(view(rm_note=[NOTE], work_item=[case], approvals=approvals), today="2026-03-26").action,
                         "propose_restriction")

    def test_rejected_exception_resumes_escalation(self):
        case = item(12, "NOVEL_CASE", "REJECTED", subject="rm_note:4")
        rejections = [event("REJECTED", "2026-03-18", 12, kind="NOVEL_CASE", detail="client has broken promises before")]
        self.assertEqual(only(view(rm_note=[NOTE], work_item=[case], rejections=rejections)).action, "propose_restriction")


class Precedents(unittest.TestCase):
    def test_rejection_becomes_live_precedent(self):
        rejected = item(7, "RESTRICTION", "REJECTED")
        v = view(work_item=[rejected], rejections=[event("REJECTED", "2026-03-10", 7, detail="Too strict for this tier")])
        rows = [m.args["row"] for m in moves(v) if m.action == "upsert_precedent"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["id"], rows[0]["decision"], rows[0]["override_reason"], rows[0]["outcome"], rows[0]["source"]),
                         ("PRC-L-7", "Rejected", "Too strict for this tier", "pending", "live"))

    def test_routine_approval_is_not_a_precedent(self):
        approved = item(7, "RESTRICTION", "POSTED")
        v = view(work_item=[approved], approvals=[event("APPROVED", "2026-03-10", 7)])
        self.assertFalse([m for m in moves(v) if m.action == "upsert_precedent"])

    def test_precedent_outcome_recorded_once_cured(self):
        rejected = item(7, "RESTRICTION", "REJECTED")
        existing = {"id": "PRC-L-7", "client_id": "ORG-1", "work_item_id": 7, "decision": "Rejected", "outcome": "pending"}
        v = view(owed=(), work_item=[rejected], precedent=[existing],
                 rejections=[event("REJECTED", "2026-03-10", 7)])
        rows = [m.args["row"] for m in moves(v) if m.action == "upsert_precedent"]
        self.assertEqual(rows[0]["outcome"], f"Cured by {TODAY}")
        v.precedent = [{**existing, "outcome": rows[0]["outcome"]}]
        self.assertFalse([m for m in moves(v) if m.action == "upsert_precedent"])


if __name__ == "__main__":
    unittest.main()
