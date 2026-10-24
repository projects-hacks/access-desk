import asyncio
import threading
import time
import unittest
from dataclasses import dataclass
from itertools import pairwise
from types import SimpleNamespace
from typing import Any
from unittest import mock

import httpx
from test_access_controller import NOTE, PAID, item, view, wire, world

from desk_agents.agents import access_controller
from desk_agents.agents.access_controller import AccessController, Move
from desk_agents.notices import Writer
from desk_agents.stdb import ReducerError


@dataclass
class Call:
    action: str
    args: dict[str, Any]
    start: float
    end: float


def not_found(action: str) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", f"http://db/call/{action}")
    response = httpx.Response(404, request=request)
    return httpx.HTTPStatusError("not found", request=request, response=response)


class FakeDb:
    """Records every reducer call with its start and end time; never touches a network."""

    def __init__(self, delay: float = 0.0, missing=(), refused=()):
        self.delay, self._missing, self._refused = delay, set(missing), set(refused)
        self.calls: list[Call] = []
        self.lock = threading.Lock()

    def __getattr__(self, action: str):
        if action.startswith("_"):
            raise AttributeError(action)

        def call(**args):
            self.record(action, args)

        return call

    def record(self, action: str, args: dict[str, Any]) -> None:
        start = time.monotonic()
        if action in self._missing:
            raise not_found(action)
        if action in self._refused:
            raise ReducerError(f"{action} refused")
        time.sleep(self.delay)
        with self.lock:
            self.calls.append(Call(action, args, start, time.monotonic()))

    def actions(self) -> list[str]:
        return [c.action for c in self.calls]


def agent(db) -> AccessController:
    return AccessController(db, reader=SimpleNamespace(), writer=Writer(None))


def move(client_id: str, n: int = 0, action: str = "act", **kw) -> Move:
    return Move(action=action, client_id=client_id, args={"client_id": client_id, "n": n}, summary=f"{action} {n}", **kw)


def parallel(n: int = 4):
    return mock.patch.object(access_controller.settings, "stdb_parallel_requests", n)


class ExecutionOrder(unittest.TestCase):
    def test_changed_clients_go_before_the_others(self):
        db = FakeDb(delay=0.05)
        moves = [move("ORG-1"), move("ORG-2"), move("ORG-3", 1), move("ORG-3", 2), move("ORG-4")]
        with parallel():
            agent(db).execute_all(moves, first={"ORG-3"})
        changed = [c for c in db.calls if c.args["client_id"] == "ORG-3"]
        others = [c for c in db.calls if c.args["client_id"] != "ORG-3"]
        self.assertEqual(len(db.calls), 5)
        self.assertLessEqual(max(c.end for c in changed), min(c.start for c in others))

    def test_other_clients_run_side_by_side(self):
        db = FakeDb(delay=0.2)
        moves = [move(f"ORG-{i}") for i in range(8)]
        started = time.monotonic()
        with parallel(4):
            agent(db).execute_all(moves, first=set())
        elapsed = time.monotonic() - started
        self.assertEqual(len(db.calls), 8)
        self.assertLess(elapsed, 0.8, f"8 calls of 0.2 s took {elapsed:.2f} s; sequential would be 1.6 s")
        overlapping = max(sum(1 for c in db.calls if c.start < t < c.end) for t in (c.start + 0.1 for c in db.calls))
        self.assertGreater(overlapping, 1)

    def test_each_clients_moves_stay_in_order_one_at_a_time(self):
        db = FakeDb(delay=0.03)
        moves = [move(cid, n) for n in range(4) for cid in ("ORG-1", "ORG-2", "ORG-3")]
        with parallel(4):
            agent(db).execute_all(moves, first={"ORG-2"})
        for cid in ("ORG-1", "ORG-2", "ORG-3"):
            with self.subTest(cid):
                own = sorted((c for c in db.calls if c.args["client_id"] == cid), key=lambda c: c.start)
                self.assertEqual([c.args["n"] for c in own], [0, 1, 2, 3])
                for a, b in pairwise(own):
                    self.assertLessEqual(a.end, b.start)

    def test_unexpected_error_stops_the_pass_and_is_raised(self):
        class Broken(FakeDb):
            def boom(self, **args):
                raise httpx.ConnectError("down")

        db = Broken()
        with parallel(1), self.assertRaises(httpx.ConnectError):
            agent(db).execute_all([move("ORG-1", action="boom"), move("ORG-1", 1), move("ORG-2")], first={"ORG-1"})
        self.assertEqual(db.calls, [])

    def test_acted_counts_successes_but_not_bookkeeping(self):
        db = FakeDb(refused={"refused"})
        a = agent(db)
        with parallel():
            a.execute_all([move("ORG-1"), move("ORG-2", action="record_wait"), move("ORG-3", action="refused"),
                           move("ORG-4", action="upsert_precedent")])
        self.assertEqual(a.acted, 1)


class Fallbacks(unittest.TestCase):
    def test_404_marks_the_reducer_unavailable_once_and_falls_back(self):
        db = FakeDb(delay=0.02, missing={"fancy"})
        a = agent(db)
        moves = [move(cid, action="fancy", fallback=move(cid, action="plain")) for cid in ("ORG-1", "ORG-2", "ORG-3")]
        with parallel(), self.assertLogs("desk_agents.access_controller", level="WARNING") as logs:
            a.execute_all(moves, first={"ORG-1"})
        self.assertEqual(a.unavailable, {"fancy"})
        self.assertEqual(sorted(c.args["client_id"] for c in db.calls), ["ORG-1", "ORG-2", "ORG-3"])
        self.assertEqual(set(db.actions()), {"plain"})
        self.assertEqual(sum("not published" in line for line in logs.output), 1)
        self.assertEqual(a.acted, 3)

    def test_after_runs_only_when_the_move_itself_succeeds(self):
        db = FakeDb(refused={"refused"}, missing={"missing"})
        a = agent(db)
        a.execute(move("ORG-1", action="ok", after=move("ORG-1", action="ok_after")))
        with self.assertLogs("desk_agents.access_controller", level="WARNING"):
            a.execute(move("ORG-2", action="refused", after=move("ORG-2", action="refused_after")))
            a.execute(move("ORG-3", action="missing", fallback=move("ORG-3", action="fallback"),
                           after=move("ORG-3", action="missing_after")))
        self.assertEqual(db.actions(), ["ok", "ok_after", "fallback"])


class Desk(FakeDb):
    """A stateful stand-in for the reducers the payment-match story touches."""

    def __init__(self, v):
        super().__init__()
        self.view = v
        self.next_id = 100

    def propose_payment_match(self, **args):
        self.record("propose_payment_match", args)
        m = next(c for c in self.view.cash if c["id"] == args["movement_id"])
        m["match_status"] = "proposed"
        plan = {"allocations": [{"invoiceId": "INV-1", "amountCents": str(m["amount_cents"])}]}
        self.add("PAYMENT_MATCH", "PROPOSED", {"movementId": m["id"], "plan": plan, "rmNoteId": args["rm_note_id"]},
                 title=f"Confirm ${m['amount_cents'] / 100:,.2f} from {m['orig_name']} → INV-1 (Acme)",
                 subject=m["id"], required_role="ACCOUNTANT", amount_cents=m["amount_cents"])

    def propose_notice(self, **args):
        self.record("propose_notice", args)
        self.add("REMINDER", "POSTED", {"channel": args["channel"], "body": args["body"]})

    def add(self, kind, state, proposal, **extra):
        self.next_id += 1
        self.view.work_item.append(item(self.next_id, kind, state, proposal, **extra))


class SamePassReply(unittest.TestCase):
    def setUp(self):
        self.v = view(rm_note=[NOTE], cash=[wire(match="exception", ref="JD-0042", value_on="2026-03-18")])
        self.w = world(self.v, readings={4: PAID})
        self.db = Desk(self.v)
        self.agent = agent(self.db)
        self.agent.observe = lambda: self.w

    def run_pass(self) -> list[Call]:
        before = len(self.db.calls)
        with parallel():
            asyncio.run(self.agent.run())
        return self.db.calls[before:]

    def test_rm_hears_back_in_the_same_pass(self):
        calls = self.run_pass()
        self.assertEqual([c.action for c in calls[:2]], ["propose_payment_match", "propose_notice"])
        reply = calls[1].args
        self.assertEqual(reply["channel"], "rm")
        self.assertEqual(reply["body"], "We found it: the $50,000.00 payment from ACME LP (JD-0042, received 2026-03-18) pays "
                                        "INV-1. An accountant is confirming the match now; access comes back as soon as it "
                                        "is applied. (re RM-4)")
        self.assertNotIn("WI-", reply["body"])
        self.assertEqual(self.agent.acted, 2)

    def test_next_pass_does_not_reply_again(self):
        self.run_pass()
        later = self.run_pass()
        self.assertFalse([c for c in later if c.action in ("propose_notice", "propose_payment_match")])
        self.assertEqual([c.args["code"] for c in later if c.action == "record_wait"], ["payment_unapplied"])

    def test_no_reply_when_the_match_is_refused(self):
        self.db._refused = {"propose_payment_match"}
        with self.assertLogs("desk_agents.access_controller", level="WARNING"):
            self.assertFalse([c for c in self.run_pass() if c.action == "propose_notice"])

    def test_unpublished_match_reducer_still_replies_once(self):
        self.db._missing = {"propose_payment_match"}
        with self.assertLogs("desk_agents.access_controller", level="WARNING"):
            calls = self.run_pass()
        notices = [c.args["body"] for c in calls if c.action == "propose_notice"]
        self.assertEqual(len(notices), 1)
        self.assertIn("could not be matched automatically", notices[0])


class WaitingMatchReply(unittest.TestCase):
    def reply(self, v):
        moves = access_controller.plan(world(v, readings={4: PAID}), escalation_days=7)
        return next(m for m in moves if m.action == "propose_notice").args["body"]

    def test_reads_amount_sender_and_invoices_from_the_match(self):
        cash = wire(match="proposed", ref="JD-0042", orig="HALVARD GP HOLDINGS", value_on="2026-03-18", mid="nessie:JD-0042")
        plan = {"allocations": [{"invoiceId": "INV-1", "amountCents": "14820000"}, {"invoiceId": "INV-2", "amountCents": "0"}]}
        match = item(40, "PAYMENT_MATCH", "PROPOSED", {"movementId": cash["id"], "plan": plan}, subject=cash["id"],
                     title="Confirm $148,200.00 from HALVARD GP HOLDINGS → INV-1, INV-2 (Acme)",
                     required_role="ACCOUNTANT", amount_cents=148_200_00)
        body = self.reply(view(rm_note=[NOTE], cash=[cash], work_item=[match]))
        self.assertEqual(body, "We found it: the $148,200.00 payment from HALVARD GP HOLDINGS (JD-0042, received 2026-03-18) "
                               "pays INV-1 and INV-2. The match is waiting for an accountant to approve (WI-40); access "
                               "comes back as soon as it is applied. (re RM-4)")

    def test_falls_back_to_the_title(self):
        match = item(40, "PAYMENT_MATCH", "PROPOSED", title="Confirm $148,200.00 from HALVARD GP HOLDINGS → INV-1 (Acme)",
                     required_role="ACCOUNTANT", subject="nessie:JD-0042")
        body = self.reply(view(rm_note=[NOTE], work_item=[match]))
        self.assertTrue(body.startswith("We found it: the $148,200.00 payment from HALVARD GP HOLDINGS pays INV-1. "), body)
        self.assertNotIn("Confirm", body)


if __name__ == "__main__":
    unittest.main()


class ObserveReadsTheAuditLogIncrementally(unittest.TestCase):
    def test_second_pass_reads_only_new_audit_rows(self):
        from types import SimpleNamespace

        from desk_agents.agents.access_controller import AccessController
        from desk_agents.notices import Writer

        class Db:
            def __init__(self):
                self.audit_queries = []

            def sql(self, q):
                if "audit_event" in q:
                    self.audit_queries.append(q)
                    return [{"id": 41, "action": "PROPOSE", "client_id": "ORG-1", "to_state": "PROPOSED", "allowed": True,
                             "detail": "", "work_item_id": None, "sim_date": "2026-03-03"}] if "id > 0" in q else []
                if q == "SELECT * FROM clock":
                    return [{"sim_date": "2026-03-03"}]
                if q == "SELECT * FROM platform":
                    return [{"auto_apply_limit_cents": 0, "wire_instructions": ""}]
                return []

        db = Db()
        agent = AccessController(db, reader=SimpleNamespace(read=None), writer=Writer(None))
        first, second = agent.observe(), agent.observe()
        self.assertEqual(db.audit_queries, ["SELECT * FROM audit_event WHERE id > 0", "SELECT * FROM audit_event WHERE id > 41"])
        self.assertEqual((first.changed, second.changed), ({"ORG-1"}, set()))
