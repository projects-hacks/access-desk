import json
import tempfile
import unittest

from policy_drafter_fakes import RULE, workspace, write_cases

from desk_agents.policy_drafter.harness import run_tests


class HarnessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws, self.sandbox, self.data = workspace(self.tmp.name)

    def tearDown(self):
        self.ws.remove()
        self.tmp.cleanup()

    def write_rule(self, rule=None):
        self.sandbox.write_file("policies/rules/pol-014.json", json.dumps(rule or RULE))

    def result(self):
        return run_tests.run_cases(self.ws.root)

    def test_planted_story_rule_passes_on_the_history(self):
        self.assertEqual(self.data["task"]["overrides"], ["PRC-0001", "PRC-0002", "PRC-0003", "PRC-L101"])
        write_cases(self.sandbox, self.data)
        self.write_rule()
        out = self.sandbox.harness("run_tests.py")
        self.assertEqual(out.returncode, 0, out.stdout)
        result = self.result()
        self.assertTrue(result["ok"], result["failures"])
        self.assertEqual(result["passed"], 9)
        kestrel = next(c for c in result["cases"] if c["precedentId"] == "PRC-L101")
        self.assertEqual((kestrel["proposed"], kestrel["got"], kestrel["facts"]["renewal_in_days"]),
                         (["api:RATE_LIMIT"], [], 5))

    def test_a_too_broad_rule_breaks_the_controls(self):
        write_cases(self.sandbox, self.data)
        self.write_rule({**RULE, "match": {"days_late_gte": 1}})
        result = self.result()
        self.assertFalse(result["ok"])
        self.assertTrue(any("PRC-0004" in f for f in result["failures"]))

    def test_case_for_an_unknown_precedent_fails(self):
        write_cases(self.sandbox, self.data)
        self.sandbox.write_file("policies/cases/PRC-9999.json", json.dumps({"precedentId": "PRC-9999", "expected": "x"}))
        self.write_rule()
        result = self.result()
        self.assertFalse(result["ok"])
        self.assertIn("cases/PRC-9999.json: unknown precedent PRC-9999", result["failures"])

    def test_wrong_expectation_fails_even_if_the_rule_agrees_with_it(self):
        write_cases(self.sandbox, self.data)
        self.sandbox.write_file("policies/cases/PRC-0004.json",
                                json.dumps({"precedentId": "PRC-0004", "expected": "Hold amount owed only"}))
        self.write_rule()
        result = self.result()
        self.assertFalse(result["ok"])
        self.assertTrue(any(f.startswith("cases/PRC-0004.json: expected") for f in result["failures"]))
        self.assertEqual(self.sandbox.harness("run_tests.py").returncode, 1)

    def test_missing_cases_and_outside_precedents_fail(self):
        write_cases(self.sandbox, self.data, ids=["PRC-0001", "PRC-0002", "PRC-0003"])
        self.sandbox.write_file("policies/cases/PRC-0012.json",
                                json.dumps({"precedentId": "PRC-0012", "expected": "Withdrawn"}))
        self.write_rule()
        failures = self.result()["failures"]
        self.assertIn("cases/PRC-L101.json: missing (override)", failures)
        self.assertIn("cases/PRC-0012.json: PRC-0012 is not one of this draft's precedents", failures)

    def test_rule_schema_is_enforced(self):
        write_cases(self.sandbox, self.data)
        self.write_rule({**RULE, "match": {"vibes": True}, "effect": {"max_step": "NUKE"}})
        failures = self.result()["failures"]
        self.assertTrue(any("match.vibes is not a known key" in f for f in failures))
        self.assertTrue(any("effect.max_step has the wrong type" in f for f in failures))

    def test_backtest_reports_the_documented_summary(self):
        write_cases(self.sandbox, self.data)
        self.write_rule()
        result = self.sandbox.harness_result("backtest.py")
        self.assertTrue(result["ok"])
        for key in ("window", "episodes", "restrictedUnderCurrent", "casesChanged", "changed", "money",
                    "wronglyRestricted", "assumptions"):
            self.assertIn(key, result)
        self.assertEqual([c["client"] for c in result["changed"]],
                         ["Fieldstone Quant", "Ember Street Capital", "Polaris Yield Fund", "Kestrel Quant"])
        fieldstone = result["changed"][0]
        self.assertEqual((fieldstone["daysToPay"], fieldstone["paidQuickly"]), (4, True))
        self.assertEqual(result["changed"][3]["owedCents"], 148_200_00)
        money = result["money"]
        self.assertEqual(money["current"]["leverSteps"] - money["draft"]["leverSteps"], 4)
        self.assertGreater(result["wronglyRestricted"]["current"]["leverSteps"],
                           result["wronglyRestricted"]["draft"]["leverSteps"])
        self.assertEqual(result["wronglyRestricted"]["paidWithinDays"], 5)
        self.assertTrue(any("Clients pay on the same dates" in a for a in result["assumptions"]))

    def test_parse_actions_reads_history_and_live_titles(self):
        self.assertEqual(run_tests.parse_actions("Hold amount owed + no new positions"),
                         {"withdrawals:HOLD_AMOUNT_OWED", "trading:NO_NEW_POSITIONS"})
        self.assertEqual(run_tests.parse_actions("Hold $148,200.00 of Kestrel Quant's withdrawals"),
                         {"withdrawals:HOLD_AMOUNT_OWED"})
        self.assertEqual(run_tests.parse_actions("no new positions on Kestrel Quant's trading"),
                         {"trading:NO_NEW_POSITIONS"})
        self.assertIsNone(run_tests.parse_actions("Net staking rewards against fees"))


if __name__ == "__main__":
    unittest.main()
