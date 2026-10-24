import json
import unittest

from desk_agents.agents.access_controller import plan
from desk_agents.pushback import RmReading, by_keywords
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
            {"id": i, "product": p, "issued_on": "2026-01-15", "due_on": "2026-02-01", "amount_cents": amt, "paid_cents": 0,
             "status": "open"}
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


RESTRICT = "propose_restriction_with_boundaries"
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
        self.assertEqual((m.action, m.args["lever"], m.args["step"]), (RESTRICT, "trading", "PAUSE_OTC"))

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
        self.assertEqual(only(v).action, RESTRICT)

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
        levers = [{"lever": "trading", "state": "limited", "detail": "OTC paused", "work_item_id": 9}]
        m = only(view(work_item=[posted], levers=levers))
        self.assertEqual(m.action, "propose_notice")
        self.assertIn("(ref WI-9)", m.args["body"])
        self.assertIn("We restore access once the payment posts", m.args["body"])
        sent = item(10, "REMINDER", "POSTED", {"body": m.args["body"]})
        self.assertNotEqual(only(view(work_item=[posted, sent], levers=levers)).action, "propose_notice")

    def test_no_restriction_notice_once_paid(self):
        posted = item(9, "RESTRICTION", "POSTED", {"lever": "trading", "step": "PAUSE_OTC"})
        levers = [{"lever": "trading", "state": "limited", "detail": "OTC paused", "work_item_id": 9}]
        m = only(view(work_item=[posted], levers=levers, owed=()))
        self.assertEqual((m.action, m.args["lever"]), ("propose_restore", "trading"))


NOTE = {"id": 4, "client_id": "ORG-1", "author": "Priya Nair", "text": "...", "work_item_id": None}
PAID = RmReading(intent="already_paid", summary="wire sent", claimed_amount_usd=50_000.0, payment_reference="IMAD123456")
HOLD_OFF = RmReading(intent="exception_request", summary="hold off", grace_until="2026-03-31", reason="acquisition")


def wire(status="posted", match="matched", value_on="2026-03-02", amount=50_000_00, orig="ACME LP", ref="WI-1",
         memo="", refs=(), mid=None):
    return {"id": mid or f"nessie:{ref}", "amount_cents": amount, "rail": "WIRE", "bank_ref": ref, "orig_name": orig,
            "value_on": value_on, "status": status, "match_status": match, "memo": memo, "remittance": "",
            "refs": list(refs)}


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

    def test_already_paid_proposes_the_match_for_unmatched_cash(self):
        m = only(view(rm_note=[NOTE], cash=[wire(match="exception")]), readings={4: PAID})
        self.assertEqual((m.action, m.args["movement_id"], m.args["rm_note_id"]), ("propose_payment_match", "nessie:WI-1", 4))
        self.assertIn("could not be matched", m.fallback.args["body"])

    def test_answered_note_is_not_answered_again(self):
        reply = item(11, "REMINDER", "POSTED", {"body": "No payment (re RM-4)"})
        self.assertEqual(only(view(rm_note=[NOTE], work_item=[reply]), readings={4: PAID}).action, RESTRICT)

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
                         RESTRICT)

    def test_rejected_exception_resumes_escalation(self):
        case = item(12, "NOVEL_CASE", "REJECTED", subject="rm_note:4")
        rejections = [event("REJECTED", "2026-03-18", 12, kind="NOVEL_CASE", detail="client has broken promises before")]
        self.assertEqual(only(view(rm_note=[NOTE], work_item=[case], rejections=rejections)).action, RESTRICT)


class Precedents(unittest.TestCase):
    def test_rejection_becomes_live_precedent(self):
        rejected = item(7, "RESTRICTION", "REJECTED")
        v = view(work_item=[rejected], rejections=[event("REJECTED", "2026-03-10", 7, detail="Too strict for this tier")])
        rows = [m.args["row"] for m in moves(v) if m.action == "upsert_precedent"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["id"], rows[0]["decision"], rows[0]["override_reason"], rows[0]["outcome"], rows[0]["source"]),
                         ("PRC-L7", "Rejected", "Too strict for this tier", "", "live"))

    def test_approvals_and_withdrawals_are_precedents_too(self):
        approved = item(7, "RESTRICTION", "POSTED", {"lever": "withdrawals", "step": "HOLD_AMOUNT_OWED"})
        withdrawn = item(8, "RESTRICTION", "WITHDRAWN", {"lever": "trading", "step": "PAUSE_OTC"})
        v = view(owed=(), work_item=[approved, withdrawn],
                 approvals=[event("APPROVED", "2026-03-10", 7)], withdrawals=[event("WITHDRAWN", "2026-03-12", 8)])
        v.invoice = [{"id": "INV-1", "product": "TRADING", "issued_on": "2026-01-15", "due_on": "2026-02-01",
                      "amount_cents": 50_000_00, "paid_cents": 50_000_00, "paid_on": "2026-03-14", "status": "paid"}]
        rows = {m.args["row"]["id"]: m.args["row"] for m in moves(v) if m.action == "upsert_precedent"}
        self.assertEqual((rows["PRC-L7"]["decision"], rows["PRC-L7"]["proposed"], rows["PRC-L7"]["outcome"]),
                         ("Approved", "Hold amount owed (withdrawals, HOLD_AMOUNT_OWED)", "Paid in 4d"))
        self.assertEqual((rows["PRC-L8"]["decision"], rows["PRC-L8"]["outcome"]),
                         ("Withdrawn", "Paid before the restriction applied (2026-03-14)"))

    def test_situation_is_short_facts_as_of_the_decision(self):
        rejected = item(7, "RESTRICTION", "REJECTED", {"lever": "trading", "step": "PAUSE_OTC"})
        v = view(usd=35_000_00, work_item=[rejected], rejections=[event("REJECTED", "2026-03-10", 7, detail="Renewal soon")],
                 position=[{"status": "open", "hedge_group": "H1", "notional_cents": 1}])
        v.client["renewal_on"] = "2026-03-22"
        row = next(m.args["row"] for m in moves(v) if m.action == "upsert_precedent")
        self.assertEqual(row["situation"], "Late 37 days, $50,000.00 past due (TRADING), coverage 0.7\u00d7, "
                                           "renewal in 12 days, tier 3, hedged positions open")
        self.assertEqual((row["proposed"], row["override_reason"]), ("Pause OTC trading (trading, PAUSE_OTC)", "Renewal soon"))

    def test_precedent_outcome_recorded_once_cured(self):
        rejected = item(7, "RESTRICTION", "REJECTED")
        existing = {"id": "PRC-L7", "client_id": "ORG-1", "work_item_id": 7, "decision": "Rejected", "outcome": ""}
        v = view(owed=(), work_item=[rejected], precedent=[existing],
                 rejections=[event("REJECTED", "2026-03-10", 7)])
        rows = [m.args["row"] for m in moves(v) if m.action == "upsert_precedent"]
        self.assertEqual(rows[0]["outcome"], "Paid in 10d")
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
        self.assertEqual((m.action, m.args["lever"], m.args["step"]), (RESTRICT, "withdrawals", "HOLD_AMOUNT_OWED"))
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


class CutoffComparison(unittest.TestCase):
    def setUp(self):
        self.v = v = view(products=("CUSTODY", "TRADING", "API"), usd=1_000_000_00,
                                    position=[{"status": "open", "hedge_group": "H1", "notional_cents": 40_000_000_00},
                                              {"status": "open", "hedge_group": "H1", "notional_cents": -38_000_000_00},
                                              {"status": "open", "hedge_group": None, "notional_cents": 2_000_000_00},
                                              {"status": "closed", "hedge_group": None, "notional_cents": 9_000_000_00}])
        v.contract_clause.append({"kind": "no_forced_close", "clause": "11", "allowed": True,
                                            "text": "The platform will not force-close client positions to recover fees."})
        v.custody_holding.append({"asset": "BTC", "value_cents": 9_000_000_00})

    def comparison(self, v):
        w = world(v)
        w.policies = [{"policy_id": "pol-006", "title": "", "rule_json": ""}, {"policy_id": "pol-008", "title": "", "rule_json": ""}]
        m = next(m for m in plan(w, escalation_days=7) if m.action == RESTRICT)
        return m, json.loads(m.args["boundaries_json"])[0]

    def test_structured_side_by_side(self):
        m, c = self.comparison(self.v)
        self.assertEqual(c["kind"], "cutoff_comparison")
        self.assertEqual((c["proposed"]["step"], c["proposed"]["positionsForceClosed"], c["proposed"]["custodyFrozenCents"]),
                         ("PAUSE_OTC", 0, 0))
        full = c["fullCutoff"]
        self.assertEqual((full["positionsForceClosed"], full["hedgesForceClosed"], full["notionalCents"]), (3, 2, 80_000_000_00))
        self.assertEqual(full["estimatedUnwindCostCents"], 400_000_00)
        self.assertEqual(full["custodyFrozenCents"], 10_000_000_00)
        self.assertEqual(full["frozenToOwed"], 200.0)
        self.assertEqual([b["clause"] for b in full["clausesBreached"]], ["11"])
        self.assertEqual(full["policiesBreached"], ["pol-006", "pol-008"])
        self.assertIn("Compared with a full cutoff: Freezes all", m.args["reasoning"])
        self.assertIn("§11 (no forced close)", full["summary"])
        self.assertEqual((c["proposed"]["approversNeeded"], full["approversNeeded"]), (0, 2))

    def test_tier_one_restriction_needs_a_controller(self):
        self.v.client["tier"] = 1
        _, c = self.comparison(self.v)
        self.assertEqual(c["proposed"]["approversNeeded"], 1)

    def test_clause_numbers_come_from_the_contract(self):
        self.v.contract_clause[-1]["clause"] = "14.2"
        _, c = self.comparison(self.v)
        self.assertIn("§14.2 (no forced close)", c["fullCutoff"]["summary"])

    def test_hold_shows_share_of_custody(self):
        flag = [{"status": "open", "pattern": "withdrawal_during_cure"}]
        self.v.exploit_flag = flag
        _, c = self.comparison(self.v)
        self.assertEqual(c["proposed"]["custodyFrozenCents"], 50_000_00)
        self.assertIn("Hold $50,000.00 of withdrawals (0.5% of $10,000,000.00 custody)", c["proposed"]["summary"])

    def test_falls_back_to_plain_reducer_until_published(self):
        m = only(self.v)
        self.assertEqual(m.fallback.action, "propose_restriction")
        self.assertNotIn("boundaries_json", m.fallback.args)


class ReviewFindings(unittest.TestCase):
    def test_hold_is_restored_when_default_ends_without_a_matched_payment(self):
        levers = [{"lever": "withdrawals", "state": "limited", "detail": "$500.00 held", "work_item_id": None}]
        v = view(levers=levers, owed=(), hold=[{"status": "active", "amount_cents": 500_00}])
        m = only(v)
        self.assertEqual((m.action, m.args["lever"]), ("propose_restore", "withdrawals"))

    def test_unapplied_cash_stops_collection_and_restriction(self):
        cash = [wire(match="proposed", value_on="2026-03-18")]
        self.assertIsNone(only(view(debit=True, usd=1_000_000_00, cash=cash)))
        self.assertEqual(waited(view(cash=cash))[0], "payment_unapplied")

    def test_old_unapplied_cash_does_not_block(self):
        self.assertIsNotNone(only(view(cash=[wire(match="exception", value_on="2025-11-01")])))

    def test_open_payment_match_stops_restriction(self):
        match = item(30, "PAYMENT_MATCH", "PROPOSED", required_role="ACCOUNTANT")
        self.assertEqual(waited(view(work_item=[match]))[0], "payment_unapplied")

    def test_returned_payment_is_reported_as_returned(self):
        m = only(view(rm_note=[NOTE], cash=[wire(match="reversed")]), readings={4: PAID})
        self.assertIn("returned by the bank", m.args["body"])

    def test_rm_note_answered_while_a_proposal_waits(self):
        pending = item(9, "RESTRICTION", "PROPOSED")
        m = only(view(rm_note=[NOTE], work_item=[pending]), readings={4: PAID})
        self.assertEqual((m.action, m.args["channel"]), ("propose_notice", "rm"))

    def test_failed_gateway_command_is_called_out(self):
        stuck = item(9, "RESTRICTION", "APPROVED")
        w = world(view(work_item=[stuck]))
        w.failed_commands = {9: "admin API timeout"}
        waits = [m.args for m in plan(w, escalation_days=7) if m.action == "record_wait"]
        self.assertEqual(waits[0]["code"], "gateway_failed")
        self.assertIn("admin API timeout", waits[0]["reason"])

    def test_preexisting_restrictions_are_described_honestly(self):
        restricted = [{"lever": "withdrawals", "state": "active", "detail": "Normal", "work_item_id": None},
                      {"lever": "trading", "state": "limited", "detail": "OTC paused", "work_item_id": None}]
        reason = waited(view(levers=restricted, cure_due="2026-03-15"))[1]
        self.assertIn("set before this agent", reason)
        m = only(view(levers=restricted, cure_due="2026-03-01"))
        self.assertNotIn("The last restriction has been in place", m.args["reasoning"])
        self.assertIn("set before this agent", m.args["reasoning"])

    def test_agreed_plan_from_an_earlier_default_does_not_apply(self):
        case = item(20, "NOVEL_CASE", "APPROVED", {"onlyLevers": ["withdrawals"], "event": "acquisition"}, subject="rm_note:4")
        v = view(work_item=[case], approvals=[event("APPROVED", "2025-10-01", 20, kind="NOVEL_CASE")])
        self.assertEqual(only(v).args["lever"], "trading")

    def test_material_event_approval_is_not_a_grace_period(self):
        case = item(20, "NOVEL_CASE", "APPROVED", {"onlyLevers": ["withdrawals"], "event": "acquisition"}, subject="rm_note:4")
        v = view(work_item=[case], approvals=[event("APPROVED", "2026-03-18", 20, kind="NOVEL_CASE")])
        self.assertEqual((only(v).args["lever"], only(v).args["step"]), ("withdrawals", "HOLD_AMOUNT_OWED"))

    def test_unparseable_grace_date_falls_back_to_spacing(self):
        case = item(12, "NOVEL_CASE", "APPROVED", {"graceUntil": "end of month"}, subject="rm_note:4")
        approvals = [event("APPROVED", "2026-03-01", 12, kind="NOVEL_CASE")]
        self.assertEqual(only(view(work_item=[case], approvals=approvals)).action, RESTRICT)

    def test_grace_wait_names_the_real_reason_debit_was_skipped(self):
        v = view(debit=True, usd=1_000_000_00, owed=(("INV-1", "TRADING", 50_000_00),),
                 rejections=[event("REJECTED", "2026-03-17", 6, kind="CUSTODY_DEBIT")])
        v.invoice[0]["due_on"] = "2026-03-15"
        self.assertIn("A controller rejected collecting from custody on 2026-03-17", waited(v)[1])

    def test_prepay_only_where_the_contract_allows_it(self):
        api_only = {"products": ("API",), "owed": (("INV-1", "API", 50_000_00),)}
        self.assertEqual(only(view(**api_only)).args["step"], "RATE_LIMIT")
        v = view(**api_only)
        v.contract_clause.append({"kind": "prepay", "clause": "9.3", "allowed": True, "text": "..."})
        self.assertEqual(only(v).args["step"], "REQUIRE_PREPAY")

    def test_one_bad_client_does_not_stop_the_others(self):
        good, bad = view(), view()
        bad.client = {**bad.client, "id": "ORG-2"}
        del bad.invoice[0]["issued_on"]
        bad.cash = [wire()]
        w = world(good)
        w.clients["ORG-2"] = bad
        with self.assertLogs("desk_agents.access_controller", level="ERROR"):
            found = [m for m in plan(w, escalation_days=7) if m.action == RESTRICT]
        self.assertEqual([m.client_id for m in found], ["ORG-1"])


class PaymentAttribution(unittest.TestCase):
    def test_unplaced_wire_matching_the_invoices_is_proposed_with_evidence(self):
        w = world(view(rm_note=[NOTE]), readings={4: PAID})
        w.unplaced = [wire(match="exception", orig="ZEPHYR CAPITAL MGMT LP", ref="JD-0001")]
        m = next(m for m in plan(w, escalation_days=7) if m.action == "propose_payment_match")
        evidence = json.loads(m.args["evidence_json"])[0]
        kinds = [s["kind"] for s in evidence["signals"]]
        self.assertEqual(kinds, ["rm_says_paid", "amount_matches_invoices", "amount_matches_claim"])
        self.assertEqual((evidence["bankRef"], evidence["invoices"]), ("JD-0001", ["INV-1"]))
        self.assertIn("RM Priya Nair says Acme paid", m.args["reasoning"])

    def test_wire_that_does_not_fit_is_not_proposed(self):
        w = world(view(rm_note=[NOTE]), readings={4: PAID.model_copy(update={"claimed_amount_usd": None})})
        w.unplaced = [wire(match="exception", amount=12_345_00)]
        m = only_in(w)
        self.assertEqual(m.action, "propose_notice")
        self.assertIn("No payment from Acme", m.args["body"])

    def test_two_equally_likely_wires_are_left_to_a_person(self):
        w = world(view(rm_note=[NOTE]), readings={4: PAID})
        w.unplaced = [wire(match="exception", ref="JD-0001"), wire(match="exception", ref="JD-0002")]
        self.assertEqual(only_in(w).action, "propose_notice")

    def test_reference_breaks_the_tie(self):
        w = world(view(rm_note=[NOTE]), readings={4: PAID})
        w.unplaced = [wire(match="exception", ref="JD-0001"), wire(match="exception", ref="JD-0002", memo="IMAD IMAD123456")]
        m = only_in(w)
        self.assertEqual((m.action, m.args["movement_id"]), ("propose_payment_match", "nessie:JD-0002"))

    def test_rm_is_pointed_at_a_match_already_waiting(self):
        match = item(40, "PAYMENT_MATCH", "PROPOSED", title="Confirm $50,000.00 from ACME LP → INV-1 (Acme)",
                     required_role="ACCOUNTANT", subject="nessie:WI-1")
        m = only(view(rm_note=[NOTE], work_item=[match]), readings={4: PAID})
        self.assertEqual(m.args["channel"], "rm")
        self.assertIn("waiting for an accountant to approve (WI-40)", m.args["body"])


def only_in(w):
    found = [m for m in plan(w, escalation_days=7) if m.action not in BOOKKEEPING]
    return found[0] if found else None


class InventedClient(unittest.TestCase):
    """The demo moment with a client that exists nowhere in the dataset: other names, amounts and products."""

    def run_story(self, cid, name, legal, owed_lines, sender, author, note_text, tier=4):
        total = sum(amount for _, _, amount in owed_lines)
        v = view(products=("CUSTODY", "API"), owed=owed_lines, tier=tier, usd=0,
                 levers=[{"lever": "withdrawals", "state": "limited", "detail": f"{usd_text(total)} held", "work_item_id": None},
                         {"lever": "api", "state": "limited", "detail": "Rate limited to 100 req/s", "work_item_id": None},
                         {"lever": "trading", "state": "not_used", "detail": "", "work_item_id": None},
                         {"lever": "financing", "state": "not_used", "detail": "", "work_item_id": None}],
                 hold=[{"status": "active", "amount_cents": total}])
        v.client = {**v.client, "id": cid, "name": name, "legal_name": legal, "relationship_manager": author}
        note = {"id": 9, "client_id": cid, "author": author, "text": note_text, "work_item_id": None}
        v.rm_note = [note]
        reading = by_keywords(note_text)
        incoming = wire(match="exception", amount=total, orig=sender, ref="JD-0042", memo=f"PMT DET: FEES {name.upper()}",
                        value_on="2026-03-18")

        w = world(v, readings={9: reading})
        w.clients = {cid: v}
        w.unplaced = [incoming]
        step1 = only_in(w)
        self.assertEqual((step1.action, step1.args["client_id"], step1.args["movement_id"]),
                         ("propose_payment_match", cid, incoming["id"]))
        evidence = json.loads(step1.args["evidence_json"])[0]
        self.assertEqual(sorted(evidence["invoices"]), sorted(i for i, _, _ in owed_lines))
        self.assertIn("remittance_names_client", [s["kind"] for s in evidence["signals"]])

        v.work_item = [item(77, "PAYMENT_MATCH", "PROPOSED", title=f"Confirm {usd_text(total)} from {sender}",
                            required_role="ACCOUNTANT", subject=incoming["id"])]
        step2 = only_in(w)
        self.assertEqual(step2.args["channel"], "rm")
        self.assertIn("(WI-77)", step2.args["body"])
        self.assertIn("(re RM-9)", step2.args["body"])

        v.work_item = [item(77, "PAYMENT_MATCH", "POSTED", subject=incoming["id"]),
                       item(78, "REMINDER", "POSTED", {"body": step2.args["body"]})]
        for inv in v.invoice:
            inv.update(paid_cents=inv["amount_cents"], paid_on="2026-03-19", status="paid")
        v.hold = [{"status": "released", "amount_cents": total}]
        v.access_lever[0].update(state="active", detail="Hold released · all assets withdrawable")
        w.unplaced = []
        step3 = only_in(w)
        self.assertEqual((step3.action, step3.args["lever"]), ("propose_restore", "api"))

        v.access_lever[1].update(state="active", detail="Restored")
        v.work_item.append(item(79, "RESTORE", "POSTED", {"lever": "api"}))
        step4 = only_in(w)
        self.assertEqual(step4.action, "propose_notice")
        self.assertIn("Payment received: your access to the API is restored. Your account is fully back to normal.", step4.args["body"])

    def test_northwind(self):
        self.run_story("ORG-77001", "Northwind Basis Fund", "Northwind Basis Fund LP",
                       (("INV-9001", "API", 12_345_67), ("INV-9002", "CUSTODY", 8_000_00)),
                       "HALVARD GP HOLDINGS", "Dana Whitlock",
                       "Northwind already paid, $20,345.67 sent by their GP last week. Please don't keep them frozen.")

    def test_a_different_client_and_amount(self):
        self.run_story("ORG-55120", "Sable Harbor Treasury", "Sable Harbor Treasury Inc",
                       (("INV-4410", "CUSTODY", 3_210_00), ("INV-4411", "API", 990_15), ("INV-4412", "API", 77_000_00)),
                       "MERIDIAN ESCROW SERVICES", "Ken Ito",
                       "They wired it yesterday via escrow, $81,200.15 total.", tier=2)


def usd_text(cents):
    return f"${cents / 100:,.2f}"


STEPS = {RESTRICT, "propose_restriction", "propose_custody_debit"}
OTHER = RmReading(intent="other", summary="FYI")


def ready(**extra):
    """A Tier 3 client restrictions auto-apply to, cure period over, custody cash a debit could take."""
    return view(tier=3, debit=True, usd=10_000_00, owed=(("INV-1", "TRADING", 50_000_00),), **extra)


class LadderPausesWhileAPersonIsLooking(unittest.TestCase):
    def steps(self, v, **kw):
        return [m for m in moves(v, **kw) if m.action in STEPS]

    def test_control_the_client_is_restricted_when_nobody_is_looking(self):
        self.assertEqual([m.action for m in self.steps(ready())], [RESTRICT])

    def test_open_exception_request(self):
        for state in ("PROPOSED", "NEEDS_INFO"):
            with self.subTest(state):
                case = item(12, "NOVEL_CASE", state, {"graceUntil": "2026-04-01"}, subject="rm_note:4")
                v = ready(rm_note=[NOTE], work_item=[case])
                self.assertEqual(self.steps(v, readings={4: HOLD_OFF}), [])
                self.assertEqual(waited(v, readings={4: HOLD_OFF})[0], "pending_decision")

    def test_unanswered_already_paid_note(self):
        v = ready(rm_note=[NOTE])
        self.assertEqual(self.steps(v, readings={4: PAID}), [])
        self.assertEqual(only(v, readings={4: PAID}).args["channel"], "rm")

    def test_note_not_read_yet(self):
        v = ready(rm_note=[NOTE])
        self.assertEqual(self.steps(v), [])
        self.assertEqual(waited(v)[0], "rm_note_pending")

    def test_exception_or_material_event_note_before_it_is_filed(self):
        for reading in (HOLD_OFF, ACQUIRED):
            with self.subTest(reading.intent):
                self.assertEqual(self.steps(ready(rm_note=[NOTE]), readings={4: reading}), [])

    def test_pending_payment_match(self):
        for proposer in ("agent", "matcher"):
            with self.subTest(proposer):
                match = item(40, "PAYMENT_MATCH", "PROPOSED", {"proposedBy": proposer}, required_role="ACCOUNTANT",
                             subject="nessie:JD-0001")
                v = ready(work_item=[match])
                self.assertEqual(self.steps(v), [])
                self.assertEqual(waited(v)[0], "payment_unapplied")

    def test_fyi_note_does_not_pause(self):
        self.assertEqual([m.action for m in self.steps(ready(rm_note=[NOTE]), readings={4: OTHER})], [RESTRICT])

    def test_whole_sequence_pauses_until_the_people_are_done(self):
        v = ready(rm_note=[NOTE])
        v.cash = [wire(match="exception", value_on="2026-03-18")]
        first = only(v, readings={4: PAID})
        self.assertEqual(first.action, "propose_payment_match")
        v.work_item = [item(40, "PAYMENT_MATCH", "PROPOSED", required_role="ACCOUNTANT", subject=v.cash[0]["id"])]
        self.assertEqual(self.steps(v, readings={4: PAID}), [])
        reply = only(v, readings={4: PAID})
        self.assertEqual(reply.args["channel"], "rm")
        v.work_item.append(item(41, "REMINDER", "POSTED", {"body": reply.args["body"]}))
        self.assertEqual(self.steps(v, readings={4: PAID}), [])
        v.work_item[0]["state"] = "REJECTED"
        v.cash = []
        self.assertEqual([m.action for m in self.steps(v, readings={4: PAID})], [RESTRICT])


if __name__ == "__main__":
    unittest.main()
