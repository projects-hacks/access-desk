import json
import unittest

from desk_agents.agents.access_controller import plan
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
        client={"id": "ORG-1", "name": "Acme", "legal_name": "Acme LP", "tier": tier, "strategic": False},
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


def world(v, today=TODAY):
    return World(
        today=today,
        platform={"auto_apply_limit_cents": 50_000_00, "wire_instructions": "ACCT 1"},
        capability=capability(),
        clients={v.id: v},
        work_items={w["id"]: w for w in v.work_item},
    )


def only(v, **kw):
    moves = plan(world(v, **kw), escalation_days=7)
    return moves[0] if moves else None


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
        approved_late = [{"sim_date": "2026-03-16", "work_item_kind": "RESTRICTION"}]
        self.assertIsNone(only(view(levers=levers, cure_due="2026-03-01", approvals=approved_late)))
        approved = [{"sim_date": "2026-03-12", "work_item_kind": "RESTRICTION"}]
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
        v = view(rejections=[{"sim_date": "2026-03-10", "work_item_kind": "RESTRICTION"}])
        self.assertIsNone(only(v))

    def test_ignores_rejection_from_earlier_episode(self):
        v = view(rejections=[{"sim_date": "2025-11-10", "work_item_kind": "RESTRICTION"}])
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
        v = view(work_item=[{"id": 9, "kind": "RESTRICTION", "state": "PROPOSED", "proposal_json": "{}"}])
        self.assertIsNone(only(v))

    def test_tells_client_after_restriction_posts(self):
        item = {"id": 9, "kind": "RESTRICTION", "state": "POSTED",
                "proposal_json": json.dumps({"lever": "trading", "step": "PAUSE_OTC"})}
        m = only(view(work_item=[item]))
        self.assertEqual(m.action, "propose_notice")
        self.assertIn("(ref WI-9)", m.args["body"])
        sent = {"id": 10, "kind": "REMINDER", "state": "POSTED", "proposal_json": json.dumps({"body": m.args["body"]})}
        self.assertNotEqual(only(view(work_item=[item, sent])).action, "propose_notice")


if __name__ == "__main__":
    unittest.main()
