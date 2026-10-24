import asyncio
import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from policy_drafter_fakes import RULE, FakeDb, history, scripted

from desk_agents.config import settings
from desk_agents.models import Role, WorkItemKind
from desk_agents.policy_drafter import PolicyDrafter, droid_runner
from desk_agents.policy_drafter.families import group

NOTE = "Too broad: only skip the API step for tier 1-3 clients; keep the rest of the rule."


class DrafterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def drafter(self, db, **kw):
        return PolicyDrafter(db, workspace_parent=self.tmp.name, **kw)

    def cycle(self, drafter):
        async def go():
            await drafter.run()
            filed = await drafter.wait()
            return filed

        return asyncio.run(go())

    # ── Trigger ────────────────────────────────────────────────────────────

    def test_pol_003_and_pol_006_are_one_family(self):
        g = group(history()["precedent"])["restriction_ladder"]
        self.assertEqual([p["id"] for p in g["overrides"]], ["PRC-0001", "PRC-0002", "PRC-0003", "PRC-L101"])
        self.assertEqual({p["policy_ref"] for p in g["overrides"]}, {"pol-003", "pol-006"})
        controls = [p["id"] for p in g["controls"]]
        self.assertNotIn("PRC-0012", controls)
        self.assertNotIn("PRC-0007", controls)
        self.assertNotIn("PRC-0006", controls)

    def test_three_history_overrides_are_below_the_threshold(self):
        db = FakeDb(history(live_override=False))
        seen = []
        self.assertEqual(self.cycle(self.drafter(db, claude=scripted(seen=seen))), 0)
        self.assertEqual((seen, db.calls), ([], []))

    def test_the_live_override_makes_four_and_drafts_pol_014(self):
        db = FakeDb(history())
        drafter = self.drafter(db, claude=scripted())
        filed = self.cycle(drafter)
        self.assertEqual(filed, 3)
        self.assertEqual(drafter.acted, 3)
        (args,) = db.reducer("upsert_policy")
        self.assertEqual(args[:3], ("pol-014", 1, "draft"))
        self.assertEqual(json.loads(args[4]), {k: RULE[k] for k in ("when", "then", "match", "effect")})
        self.assertEqual(args[5], "PRC-0001,PRC-0002,PRC-0003,PRC-L101")
        self.assertEqual(args[6], {"none": []})
        (p,) = db.proposals()
        self.assertEqual((p.kind, p.required_role, p.client_id), (WorkItemKind.POLICY_DRAFT, Role.CONTROLLER, ""))
        self.assertEqual(p.subject_id, "policy_draft:restriction_ladder:pol-014@1:r1")
        body = p.proposal
        self.assertEqual(body["precedentIds"], ["PRC-0001", "PRC-0002", "PRC-0003", "PRC-L101"])
        self.assertEqual((body["tests"]["ok"], body["tests"]["passed"]), (True, 9))
        self.assertEqual(body["backtest"]["casesChanged"], 4)
        self.assertEqual(body["ruleBefore"]["policyId"], "pol-006")
        self.assertIn('+  "match": {', body["diff"])
        self.assertEqual(body["runner"], "claude")
        (inv,) = db.reducer("record_investigation")
        item_id = db.tables["work_item"][0]["id"]
        self.assertEqual(inv[0], item_id)
        tools = [s["tool"] for s in inv[1]]
        for tool in ("plan", "write_file", "run_tests", "backtest", "submit_draft", "diff"):
            self.assertIn(tool, tools)
        self.assertEqual(body["investigation"], inv[1])

    def test_threshold_is_a_setting(self):
        db = FakeDb(history())
        with mock.patch.object(settings, "policy_draft_threshold", 5):
            self.assertEqual(self.cycle(self.drafter(db, claude=scripted())), 0)
        self.assertEqual(db.proposals(), [])

    def test_covered_precedents_do_not_fire_again(self):
        db = FakeDb(history())
        drafter = self.drafter(db, claude=scripted())
        self.cycle(drafter)
        self.assertEqual(self.cycle(drafter), 0)
        db.decide(db.tables["work_item"][0]["id"], "APPROVED")
        self.assertEqual(self.cycle(drafter), 0)
        self.assertEqual(len(db.proposals()), 1)

    def test_nothing_new_starts_while_a_draft_runs(self):
        db = FakeDb(history())
        gate = asyncio.Event()
        calls = []

        async def slow(sandbox, task, ws):
            calls.append(task)
            await gate.wait()
            return False

        drafter = self.drafter(db, claude=slow)

        async def go():
            await drafter.run()
            await asyncio.sleep(0)
            queries = len(db.queries)
            await drafter.run()
            await drafter.run()
            self.assertEqual(len(db.queries), queries)
            gate.set()
            await drafter.wait()

        with self.assertLogs("desk_agents.policy_drafter", "WARNING"):
            asyncio.run(go())
        self.assertEqual(len(calls), 1)
        self.assertEqual(db.proposals(), [])

    def test_record_investigation_404_keeps_steps_in_the_proposal(self):
        db = FakeDb(history(), missing=("record_investigation",))
        with self.assertLogs("desk_agents.policy_drafter", "WARNING") as logs:
            self.assertEqual(self.cycle(self.drafter(db, claude=scripted())), 2)
        self.assertTrue(any("record_investigation is not published" in line for line in logs.output))
        self.assertTrue(db.proposals()[0].proposal["investigation"])

    def test_failing_tests_file_nothing_and_do_not_retry(self):
        db = FakeDb(history())
        seen = []
        drafter = self.drafter(db, claude=scripted({**RULE, "match": {"days_late_gte": 1}}, seen=seen))
        with self.assertLogs("desk_agents.policy_drafter", "WARNING"):
            self.assertEqual(self.cycle(drafter), 0)
        self.assertEqual(self.cycle(drafter), 0)
        self.assertEqual((len(seen), db.calls), (1, []))

    # ── Revision ───────────────────────────────────────────────────────────

    def test_a_rejection_with_a_note_gets_exactly_one_revision(self):
        db = FakeDb(history())
        seen = []
        drafter = self.drafter(db, claude=scripted(seen=seen))
        self.cycle(drafter)
        first = db.tables["work_item"][0]["id"]
        db.decide(first, "REJECTED", NOTE)

        self.assertEqual(self.cycle(drafter), 3)
        self.assertEqual(seen[1]["rejectionNote"], NOTE)
        self.assertEqual(seen[1]["revision"], 2)
        second = db.proposals()[1]
        self.assertEqual(second.subject_id, "policy_draft:restriction_ladder:pol-014@2:r2")
        self.assertEqual((second.proposal["revisedFrom"], second.proposal["rejectionNote"]), (first, NOTE))
        self.assertEqual(db.reducer("upsert_policy")[1][:3], ("pol-014", 2, "draft"))
        self.assertIn(NOTE, second.reasoning)

        self.assertEqual(self.cycle(drafter), 0)
        db.decide(db.tables["work_item"][1]["id"], "REJECTED", "Still no.")
        with self.assertLogs("desk_agents.policy_drafter", "INFO"):
            self.assertEqual(self.cycle(drafter), 0)
        self.assertIn("restriction_ladder", drafter.stopped)
        self.assertEqual((len(db.proposals()), len(seen)), (2, 2))

    def test_a_rejection_without_a_note_is_final_for_that_draft(self):
        db = FakeDb(history())
        drafter = self.drafter(db, claude=scripted())
        self.cycle(drafter)
        db.decide(db.tables["work_item"][0]["id"], "REJECTED", "")
        with self.assertLogs("desk_agents.policy_drafter", "INFO"):
            self.assertEqual(self.cycle(drafter), 0)
        self.assertEqual(self.cycle(drafter), 0)
        self.assertEqual(len(db.proposals()), 1)

    # ── Compatibility with activatePolicyDraft (origin/aryan) ──────────────

    def test_policy_key_matches_the_saved_row_and_a_revision_bumps_the_version(self):
        db = FakeDb(history())
        drafter = self.drafter(db, claude=scripted())
        self.cycle(drafter)
        first = db.proposals()[0].proposal
        self.assertEqual(first["policy_key"], "pol-014@1")
        saved = [p for p in db.tables["policy"] if p["policy_id"] == "pol-014"]
        self.assertEqual([(p["key"], p["status"]) for p in saved], [("pol-014@1", "draft")])

        db.decide(db.tables["work_item"][0]["id"], "REJECTED", NOTE)
        self.assertEqual(self.cycle(drafter), 3)
        second = db.proposals()[1].proposal
        self.assertEqual((second["policy_key"], second["version"]), ("pol-014@2", 2))
        rows = {p["key"]: p["status"] for p in db.tables["policy"] if p["policy_id"] == "pol-014"}
        self.assertEqual(rows, {"pol-014@1": "rejected", "pol-014@2": "draft"})
        self.assertEqual([a[:3] for a in db.reducer("upsert_policy")], [("pol-014", 1, "draft"), ("pol-014", 2, "draft")])

    def test_a_new_draft_after_activation_never_overwrites_the_active_row(self):
        tables = history()
        tables["policy"].append({"key": "pol-014@1", "policy_id": "pol-014", "version": 1, "status": "active",
                                 "title": "older", "rule_json": "{}", "learned_from": "", "approved_by": "ctl"})
        db = FakeDb(tables)
        self.assertEqual(self.cycle(self.drafter(db, claude=scripted())), 3)
        self.assertEqual(db.proposals()[0].proposal["policy_key"], "pol-014@2")
        self.assertEqual(next(p for p in db.tables["policy"] if p["key"] == "pol-014@1")["status"], "active")

    def test_draft_policy_ids_are_platform_wide(self):
        from desk_agents.policy_drafter.families import FAMILIES

        self.assertTrue(all(":" not in f.draft_policy_id for f in FAMILIES))
        db = FakeDb(history())
        self.cycle(self.drafter(db, claude=scripted()))
        self.assertEqual(db.proposals()[0].client_id, "")

    def test_credit_precedents_are_not_in_any_family(self):
        tables = history(live_override=False)
        for n, ref in enumerate(("pol-020", "pol-021", "pol-022", "pol-020")):
            tables["precedent"].append({
                "id": f"PRC-L{200 + n}", "client_id": "ORG-90412", "work_item_id": 200 + n, "decided_on": "2026-03-05",
                "situation": "tier review", "proposed": "Orchard Treasury: tier 3 → 5", "decision": "Rejected",
                "override_reason": "no", "outcome": "", "policy_ref": ref, "source": "live",
            })
        groups = group(tables["precedent"])
        self.assertEqual(len(groups["restriction_ladder"]["overrides"]), 3)
        self.assertEqual(list(groups), ["restriction_ladder"])
        db = FakeDb(tables)
        self.assertEqual(self.cycle(self.drafter(db, claude=scripted())), 0)
        self.assertEqual(db.proposals(), [])

    # ── Runners ────────────────────────────────────────────────────────────

    def test_a_failed_droid_run_falls_back_to_claude(self):
        db = FakeDb(history())

        async def broken(sandbox, task, ws):
            sandbox.write_file("policies/rules/pol-014.json", "{half a rule")
            raise RuntimeError("droid exited")

        with self.assertLogs("desk_agents.policy_drafter", "ERROR"):
            self.assertEqual(self.cycle(self.drafter(db, droid=broken, claude=scripted())), 3)
        body = db.proposals()[0].proposal
        self.assertEqual(body["runner"], "claude")
        self.assertIn("fallback", [s["tool"] for s in body["investigation"]])

    def test_without_droid_the_claude_tool_runner_is_used(self):
        db = FakeDb(history())
        client = FakeAnthropic()
        with mock.patch.object(droid_runner, "droid_available", return_value="the droid CLI (droid) is not installed"), \
                mock.patch.object(settings, "anthropic_api_key", "sk-test"), \
                mock.patch("desk_agents.policy_drafter.agent.anthropic.Anthropic", return_value=client) as ctor, \
                self.assertLogs("desk_agents.policy_drafter", "WARNING") as logs:
            self.assertEqual(self.cycle(self.drafter(db)), 3)
        self.assertTrue(any("denied write_file" in line for line in logs.output))
        ctor.assert_called_once()
        kwargs = client.kwargs
        self.assertEqual(kwargs["model"], settings.anthropic_model)
        self.assertEqual(kwargs["thinking"], {"type": "adaptive"})
        self.assertEqual(kwargs["output_config"], {"effort": "high"})
        self.assertNotIn("tool_choice", kwargs)
        self.assertEqual(db.proposals()[0].proposal["runner"], "claude")
        self.assertIn("Denied", client.denied)

    def test_no_key_and_no_droid_skips_cleanly(self):
        db = FakeDb(history())
        with mock.patch.object(droid_runner, "droid_available", return_value="the droid CLI (droid) is not installed"), \
                mock.patch.object(settings, "anthropic_api_key", None):
            drafter = self.drafter(db)
            with self.assertLogs("desk_agents.policy_drafter", "WARNING") as logs:
                self.assertEqual(asyncio.run(drafter.run()), [])
            self.assertEqual(asyncio.run(drafter.run()), [])
        self.assertEqual(len(logs.output), 1)
        self.assertIn("drafting unavailable", logs.output[0])
        self.assertEqual((db.queries, db.calls, drafter.acted), ([], [], 0))


class FakeAnthropic:
    """Stands in for anthropic.Anthropic: its tool runner plays the model by calling the real tools."""

    def __init__(self):
        self.kwargs = {}
        self.denied = ""
        self.beta = SimpleNamespace(messages=SimpleNamespace(tool_runner=self.tool_runner))

    def tool_runner(self, **kwargs):
        self.kwargs = kwargs
        tools = {t.name: t for t in kwargs["tools"]}

        def turns():
            task = json.loads(tools["read_file"].call({"path": "data/task.json"}))
            precedents = {p["id"]: p for p in json.loads(tools["read_file"].call({"path": "data/precedents.json"}))}
            yield message("tool_use", "Reading the task.")
            self.denied = tools["write_file"].call({"path": "harness/run_tests.py", "content": "print('pass')"})
            for pid in task["overrides"] + task["controls"]:
                tools["write_file"].call({"path": f"policies/cases/{pid}.json", "content": json.dumps(
                    {"precedentId": pid, "expected": precedents[pid]["decision"]})})
            tools["write_file"].call({"path": "policies/rules/pol-014.json", "content": json.dumps(RULE)})
            tools["run_command"].call({"command": "python harness/run_tests.py"})
            tools["run_command"].call({"command": "python harness/backtest.py"})
            tools["submit_draft"].call({"policy_id": "pol-014", "summary": "Hold only near renewal."})
            yield message("tool_use", "Submitted.")
            yield message("end_turn", "Done.")

        return turns()


def message(stop_reason, text):
    return SimpleNamespace(stop_reason=stop_reason, content=[SimpleNamespace(type="text", text=text)])


if __name__ == "__main__":
    unittest.main()
