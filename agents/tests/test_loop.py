import asyncio
import unittest
from unittest import mock

import httpx

from desk_agents import __main__ as main


class FakeDb:
    def __init__(self, fingerprints, publish_runs=True):
        self.fingerprints = list(fingerprints)
        self.publish_runs = publish_runs
        self.runs = []

    def fingerprint(self):
        if not self.fingerprints:
            raise asyncio.CancelledError
        return self.fingerprints.pop(0)

    def propose(self, proposal):
        pass

    def record_agent_run(self, agent, trigger, proposed, status, error, duration_ms):
        if not self.publish_runs:
            response = httpx.Response(404, request=httpx.Request("POST", "http://db/call/record_agent_run"))
            raise httpx.HTTPStatusError("not found", request=response.request, response=response)
        self.runs.append((agent, trigger, proposed, status, error))


class FakeAgent:
    name = "fake"

    def __init__(self, acts=0, fail=False):
        self.calls, self.acted, self.fail = 0, acts, fail

    async def run(self):
        self.calls += 1
        if self.fail:
            raise RuntimeError("boom")
        return []


def run_loop(db, agent, interval=1000.0):
    async def no_sleep(_):
        return None

    with mock.patch.object(main.settings, "agent_interval_seconds", interval), \
            mock.patch.object(main.asyncio, "sleep", no_sleep):
        try:
            asyncio.run(main.loop([agent], db))
        except asyncio.CancelledError:
            pass


class Loop(unittest.TestCase):
    def test_runs_on_startup_and_on_each_change_only(self):
        db, agent = FakeDb([(1, "d"), (1, "d"), (2, "d"), (2, "d"), (2, "e")]), FakeAgent(acts=1)
        run_loop(db, agent)
        self.assertEqual(agent.calls, 3)
        self.assertEqual([r[1] for r in db.runs], ["startup", "change · audit #2 · d", "change · audit #2 · e"])

    def test_runs_that_do_nothing_are_not_recorded(self):
        db, agent = FakeDb([(1, "d"), (2, "d"), (3, "d")]), FakeAgent()
        run_loop(db, agent)
        self.assertEqual(agent.calls, 3)
        self.assertEqual([r[1] for r in db.runs], ["startup"])

    def test_idle_runs_are_not_recorded_unless_they_act(self):
        db, agent = FakeDb([(1, "d"), (1, "d"), (1, "d")]), FakeAgent()
        run_loop(db, agent, interval=0.0)
        self.assertEqual(agent.calls, 3)
        self.assertEqual([r[1] for r in db.runs], ["startup"])
        db, agent = FakeDb([(1, "d"), (1, "d")]), FakeAgent(acts=2)
        run_loop(db, agent, interval=0.0)
        self.assertEqual([(r[1], r[2]) for r in db.runs], [("startup", 2), ("interval", 2)])

    def test_failed_run_is_recorded_and_loop_continues(self):
        db, agent = FakeDb([(1, "d"), (2, "d")]), FakeAgent(fail=True)
        run_loop(db, agent)
        self.assertEqual(agent.calls, 2)
        self.assertEqual([(r[3], r[4]) for r in db.runs], [("error", "RuntimeError: boom")] * 2)

    def test_unpublished_reducer_stops_recording_quietly(self):
        db, agent = FakeDb([(1, "d"), (2, "d"), (3, "d")], publish_runs=False), FakeAgent()
        with self.assertLogs("desk_agents", level="WARNING") as logs:
            run_loop(db, agent)
        self.assertEqual(agent.calls, 3)
        self.assertEqual(len([m for m in logs.output if "not published" in m]), 1)


if __name__ == "__main__":
    unittest.main()
