import unittest
from types import SimpleNamespace

import anthropic
import httpx

from desk_agents.agents.access_controller import AccessController, Move
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


class FakeClaude:
    def __init__(self, text="", stop="end_turn", error=None):
        self.text, self.stop, self.error, self.requests = text, stop, error, []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **request):
        self.requests.append(request)
        if self.error:
            raise self.error
        return SimpleNamespace(stop_reason=self.stop, content=[SimpleNamespace(type="text", text=self.text)])


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
    def test_claude_words_it_and_the_tag_is_kept(self):
        claude = FakeClaude(GOOD)
        text, by_claude = Writer(claude).write("email", DRAFT, "Client: Kestrel Quant")
        self.assertTrue(by_claude)
        self.assertEqual(text, GOOD + " (ref WI-12)")
        sent = claude.requests[0]
        self.assertNotIn("(ref WI-12)", sent["messages"][0]["content"])
        self.assertEqual((sent["fallbacks"], sent["output_config"]), ("default", {"effort": "low"}))

    def test_unsafe_wording_sends_the_template(self):
        with self.assertLogs("desk_agents.notices", level="WARNING"):
            text, by_claude = Writer(FakeClaude(GOOD.replace("$148,200.00", "$148,000.00"))).write("email", DRAFT, "")
        self.assertEqual((text, by_claude), (DRAFT, False))

    def test_refusal_sends_the_template(self):
        with self.assertLogs("desk_agents.notices", level="WARNING"):
            self.assertEqual(Writer(FakeClaude(GOOD, stop="refusal")).write("rm", DRAFT, ""), (DRAFT, False))

    def test_api_error_sends_the_template(self):
        request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
        error = anthropic.APIConnectionError(request=request)
        with self.assertLogs("desk_agents.notices", level="WARNING"):
            self.assertEqual(Writer(FakeClaude(error=error)).write("email", DRAFT, ""), (DRAFT, False))

    def test_no_key_sends_the_template(self):
        self.assertEqual(Writer(None).write("email", DRAFT, ""), (DRAFT, False))


class AgentUsesTheWriter(unittest.TestCase):
    def test_notice_reasoning_says_claude_worded_it(self):
        agent = AccessController(db=None, reader=SimpleNamespace(), writer=Writer(FakeClaude(GOOD)))
        agent.names = {"ORG-90412": "Kestrel Quant"}
        move = Move("propose_notice", "ORG-90412",
                    {"client_id": "ORG-90412", "channel": "email", "body": DRAFT, "reasoning": "Tell the client.",
                     "policy_ref": "pol-007", "confidence": 0.95}, "notice")
        worded = agent.worded(move)
        self.assertEqual(worded.args["body"], GOOD + " (ref WI-12)")
        self.assertEqual(worded.args["reasoning"], "Tell the client. Worded by Claude; every number checked against the facts.")

    def test_template_kept_without_claude(self):
        agent = AccessController(db=None, reader=SimpleNamespace(), writer=Writer(None))
        move = Move("propose_notice", "ORG-1", {"channel": "rm", "body": DRAFT, "reasoning": "r"}, "notice")
        self.assertIs(agent.worded(move), move)


if __name__ == "__main__":
    unittest.main()
