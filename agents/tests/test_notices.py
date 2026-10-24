import json
import unittest
from types import SimpleNamespace

from desk_agents.agents.access_controller import AccessController, Move
from desk_agents.llm.types import DecisionUnavailable, Reply
from desk_agents.notices import Writer, safe

DRAFT = (
    "We have placed a hold on withdrawals equal to the amount past due because $148,200.00 is past due "
    "(INV-1747, INV-1748, INV-1749). To restore access, pay the amount past due: Northstar Prime Ltd · "
    "ACCT 8262801103717637 · reference your client id. We restore access once the payment posts. (ref WI-12)"
)
GOOD = (
    "Because $148,200.00 is past due on INV-1747, INV-1748 and INV-1749, we've held that amount of your "
    "withdrawals. Everything else on your account works as usual. Paying to Northstar Prime Ltd · ACCT "
    "8262801103717637 (quote your client id) lifts the hold once the payment posts."
)


def provider(name, text=None, error=None, calls=None):
    """A fake provider: answers {"text": text}, or raises."""

    def ask(messages):
        if calls is not None:
            calls.append((name, messages))
        if error:
            raise error
        return Reply(json.dumps({"text": text}), [], provider=name)

    return name, ask


class NumberCheck(unittest.TestCase):
    def test_faithful_rewrite_passes(self):
        self.assertIsNone(safe(DRAFT, GOOD))

    def test_invented_amount_fails(self):
        self.assertIn("$150,000.00", safe(DRAFT, GOOD.replace("$148,200.00", "$150,000.00")))

    def test_new_date_fails(self):
        self.assertIn("2026-03-20", safe(DRAFT, GOOD + " Please pay by 2026-03-20."))

    def test_dropped_invoice_fails(self):
        self.assertIn("INV-1749", safe(DRAFT, GOOD.replace(" and INV-1749", "")))

    def test_dropped_amount_fails(self):
        self.assertIn("$148,200.00", safe(DRAFT, GOOD.replace("$148,200.00", "the amount")))

    def test_reformatted_amount_fails(self):
        self.assertIsNotNone(safe(DRAFT, GOOD.replace("$148,200.00", "$148.2k")))


class Writing(unittest.TestCase):
    def test_factory_words_it_and_the_tag_is_kept(self):
        calls = []
        text, by = Writer([provider("factory", GOOD, calls=calls), provider("anthropic", GOOD, calls=calls)]).write(
            "email", DRAFT, "Client: Kestrel Quant")
        self.assertEqual((text, by), (GOOD + " (ref WI-12)", "factory"))
        self.assertEqual([c[0] for c in calls], ["factory"])
        self.assertNotIn("(ref WI-12)", calls[0][1][0]["content"])

    def test_factory_failure_falls_back_to_claude(self):
        with self.assertLogs("desk_agents.seat2_llm", level="WARNING"):
            _text, by = Writer([provider("factory", error=DecisionUnavailable("droid timed out after 15s")),
                               provider("anthropic", GOOD)]).write("email", DRAFT, "")
        self.assertEqual(by, "anthropic")

    def test_wording_that_fails_the_number_check_goes_to_the_next_provider(self):
        bad = GOOD.replace("$148,200.00", "$148,000.00")
        with self.assertLogs("desk_agents.seat2_llm", level="WARNING") as logs:
            _text, by = Writer([provider("factory", bad), provider("anthropic", GOOD)]).write("email", DRAFT, "")
        self.assertEqual(by, "anthropic")
        self.assertIn("$148,000.00", " ".join(logs.output))

    def test_every_provider_failing_sends_the_template(self):
        with self.assertLogs("desk_agents.seat2_llm", level="WARNING"):
            result = Writer([provider("factory", error=DecisionUnavailable("no answer")),
                             provider("anthropic", "not json at all")]).write("rm", DRAFT, "")
        self.assertEqual(result, (DRAFT, ""))

    def test_no_providers_sends_the_template(self):
        self.assertEqual(Writer(None).write("email", DRAFT, ""), (DRAFT, ""))


class AgentUsesTheWriter(unittest.TestCase):
    def test_notice_reasoning_names_who_worded_it(self):
        agent = AccessController(db=None, reader=SimpleNamespace(), writer=Writer([provider("factory", GOOD)]))
        agent.names = {"ORG-90412": "Kestrel Quant"}
        move = Move("propose_notice", "ORG-90412",
                    {"client_id": "ORG-90412", "channel": "email", "body": DRAFT, "reasoning": "Tell the client.",
                     "policy_ref": "pol-007", "confidence": 0.95}, "notice")
        worded = agent.worded(move)
        self.assertEqual(worded.args["body"], GOOD + " (ref WI-12)")
        self.assertEqual(worded.args["reasoning"],
                         "Tell the client. Worded by Factory (Droid); every number checked against the facts.")

    def test_template_kept_without_providers(self):
        agent = AccessController(db=None, reader=SimpleNamespace(), writer=Writer(None))
        move = Move("propose_notice", "ORG-1", {"channel": "rm", "body": DRAFT, "reasoning": "r"}, "notice")
        self.assertIs(agent.worded(move), move)


if __name__ == "__main__":
    unittest.main()
