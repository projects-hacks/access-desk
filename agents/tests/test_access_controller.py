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
            "title": f"{kind} {item_id}", "reasoning": "why", "policy_ref": "pol-006", "required_role": "CONTROLLER", **extra}


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


BOOKKEEPING = {"upsert_precedent", "record_investigation", "record_wait"}


def only(v, **kw):
    found = [m for m in moves(v, **kw) if m.action not in BOOKKEEPING]
    return found[0] if found else None


def waited(v, **kw):
    found = [m for m in moves(v, **kw) if m.action == "record_wait"]
    return (found[0].args["code"], found[0].args["reason"]) if found else None


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
        transit = {"amount_cents": 50_000_00, "rail": "WIRE", "bank_ref": "WI-5412", "orig_name": "ACME LP", "value_on": "2026-03-19"}
        self.assertIsNone(only(view(in_transit=[transit])))

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


ACQUIRED = RmReading(intent="material_event", summary="being acquired", event_type="acquisition",
                     counterparty="Meridian Holdings", effective_date="2026-04-15")


def cobalt(**extra):
    v = view(products=("CUSTODY", "API"), owed=(("INV-1760", "CUSTODY", 38_200_00), ("INV-1761", "API", 23_200_00)),
             cure="open", cure_due="2026-03-14", usd=189_470_00, rm_note=[NOTE], **extra)
    v.contract_clause.append({"kind": "change_of_control", "clause": "12.4", "allowed": True,
                              "text": "Amounts due become payable at the closing of a change of control."})
    v.contract_clause[1]["allowed"] = False
    return v


def world_with_policies(v, **kw):
    w = world(v, **kw)
    w.policies = [{"policy_id": "pol-006", "title": "Restrict one lever one step at a time", "rule_json": "{}"}]
    return w


class MaterialEvent(unittest.TestCase):
    def case(self, v, **kw):
        found = [m for m in plan(world_with_policies(v, readings={4: ACQUIRED}, **kw), escalation_days=7)
                 if m.action == "propose"]
        return found[0].args["p"] if found else None

    def test_acquisition_becomes_novel_case_with_investigation(self):
        p = self.case(cobalt(), today="2026-03-03")
        self.assertEqual((p.kind.value, p.required_role.value, p.subject_id), ("NOVEL_CASE", "CONTROLLER", "rm_note:4"))
        tools = [s["tool"] for s in p.proposal["investigation"]]
        self.assertEqual(tools, ["rm_note", "policy_search", "contract", "exposure", "custody_activity", "proposal"])
        steps = {s["tool"]: s["summary"] for s in p.proposal["investigation"]}
        self.assertIn("None of the 1 active policies covers a change of control", steps["policy_search"])
        self.assertIn("§12.4", steps["contract"])
        self.assertIn("Meridian Holdings", p.title)
        self.assertIn("Invoke §12.4", p.reasoning)
        self.assertIn("No restriction before the cure period ends 2026-03-14", p.reasoning)
        self.assertIn("hold $61,400.00 of withdrawals under §7.2", p.reasoning)
        self.assertIn("written consent to debit", p.reasoning)
        self.assertEqual(p.clauses_cited, ["12.4", "7.2"])

    def test_cash_leaving_custody_is_called_out(self):
        withdrawals = [{"action": "withdraw", "decision": "approved", "allowed_cents": 1_350_000_00}]
        flags = [{"status": "open", "pattern": "withdrawal_during_cure"}]
        p = self.case(cobalt(access_request=withdrawals, exploit_flag=flags), today="2026-03-03")
        steps = {s["tool"]: s["summary"] for s in p.proposal["investigation"]}
        self.assertIn("$1,350,000.00 withdrawn", steps["custody_activity"])
        self.assertIn("withdrawal_during_cure", steps["custody_activity"])
        self.assertIn("secure the balance before closing", p.reasoning)

    def test_approved_plan_restricts_only_withdrawals(self):
        case = item(20, "NOVEL_CASE", "APPROVED", {"onlyLevers": ["withdrawals"]}, subject="rm_note:4")
        v = cobalt(work_item=[case], approvals=[event("APPROVED", "2026-03-05", 20, kind="NOVEL_CASE")])
        v.deadline[0].update(status="expired")
        m = only(v, today="2026-03-15")
        self.assertEqual((m.action, m.args["lever"], m.args["step"]), ("propose_restriction", "withdrawals", "HOLD_AMOUNT_OWED"))
        v.access_lever[0].update(state="limited", detail="$61,400.00 held")
        self.assertIsNone(only(v, today="2026-04-01"))

    def test_investigation_recorded_once(self):
        case = item(20, "NOVEL_CASE", "PROPOSED", {"investigation": [{"tool": "rm_note", "summary": "x"}]}, subject="rm_note:4")
        w = world_with_policies(cobalt(work_item=[case]))
        rec = [m for m in plan(w, escalation_days=7) if m.action == "record_investigation"]
        self.assertEqual(rec[0].args, {"work_item_id": 20, "steps": [{"tool": "rm_note", "summary": "x", "status": "done"}]})
        w.investigated = {20}
        self.assertFalse([m for m in plan(w, escalation_days=7) if m.action == "record_investigation"])


class WhyIDidntAct(unittest.TestCase):
    def test_each_reason_to_wait_is_recorded(self):
        transit = {"amount_cents": 50_000_00, "rail": "WIRE", "bank_ref": "WI-5412", "orig_name": "ACME LP", "value_on": "2026-03-19"}
        promise = {"id": 2, "kind": "promise_to_pay", "started_on": TODAY, "due_on": "2026-03-25", "status": "open",
                   "note": "CFO promised a wire"}
        restricted = [
            {"lever": "withdrawals", "state": "active", "detail": "Normal", "work_item_id": None},
            {"lever": "trading", "state": "limited", "detail": "OTC paused", "work_item_id": None},
        ]
        cases = {
            "cure_period": view(cure="open"),
            "awaiting_default_notice": view(cure=None),
            "payment_in_transit": view(in_transit=[transit]),
            "promise_to_pay": view(deadline=[promise]),
            "controller_rejected": view(rejections=[event("REJECTED", "2026-03-10", 5, detail="Too strict for this tier")]),
            "escalation_spacing": view(levers=restricted, cure_due="2026-03-15"),
            "no_further_step": view(products=("CUSTODY",), owed=(("INV-1", "CUSTODY", 100_00),), set_off=False),
            "pending_decision": view(work_item=[item(9, "RESTRICTION", "PROPOSED")]),
        }
        for code, v in cases.items():
            with self.subTest(code):
                self.assertEqual(waited(v)[0], code)
        self.assertIn("WI-5412", waited(cases["payment_in_transit"])[1])
        self.assertIn("CFO promised a wire", waited(cases["promise_to_pay"])[1])
        self.assertIn("“Too strict for this tier”", waited(cases["controller_rejected"])[1])
        self.assertIn("until 2026-03-22", waited(cases["escalation_spacing"])[1])

    def test_inside_grace_period_explains_why_no_debit(self):
        v = view(owed=(("INV-1", "TRADING", 50_000_00),))
        v.invoice[0]["due_on"] = "2026-03-15"
        code, reason = waited(v)
        self.assertEqual(code, "grace_period")
        self.assertIn("in default from 2026-03-26", reason)
        self.assertIn("consent (§6.3)", reason)

    def test_same_reason_is_recorded_once(self):
        v = view(cure="open")
        w = world(v)
        first = [m for m in plan(w, escalation_days=7) if m.action == "record_wait"]
        w.last_waits = {v.id: first[0].args["reason"]}
        self.assertFalse([m for m in plan(w, escalation_days=7) if m.action == "record_wait"])

    def test_nothing_recorded_for_clients_who_owe_nothing(self):
        self.assertIsNone(waited(view(owed=())))
        self.assertIsNone(waited(view(owed=(), work_item=[item(9, "RESTRICTION", "PROPOSED")])))


if __name__ == "__main__":
    unittest.main()
