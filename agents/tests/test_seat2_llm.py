import json
import unittest
from unittest import mock

from desk_agents import seat2_llm
from desk_agents.llm.types import DecisionUnavailable, Reply
from desk_agents.pushback import Reader

PAID = {"intent": "already_paid", "summary": "wire sent", "claimed_amount_usd": 148200.0, "payment_reference": None,
        "grace_until": None, "reason": None, "event_type": None, "counterparty": None, "effective_date": None}
NOTE = "Kestrel already paid: $148,200 sent by their GP last week."


def answering(name, payload=None, error=None, calls=None):
    def ask(messages):
        if calls is not None:
            calls.append(name)
        if error:
            raise error
        return Reply(payload if isinstance(payload, str) else json.dumps(payload), [], provider=name)

    return name, ask


class Order(unittest.TestCase):
    def test_default_orders(self):
        self.assertEqual(seat2_llm.rm_note_order(), "anthropic,factory")
        self.assertEqual(seat2_llm.notice_order(), "factory,anthropic")

    def test_chain_skips_unavailable_providers_and_passes_timeouts(self):
        built = []

        def builder(name, available):
            def build(schema=None, timeout=None):
                built.append((name, timeout))
                return (lambda messages: None) if available else None
            return build

        fake = {"factory": builder("factory", False), "anthropic": builder("anthropic", True)}
        with mock.patch.dict(seat2_llm.BUILDERS, fake, clear=True):
            asks = seat2_llm.chain("factory,anthropic,unknown,factory", {}, {"factory": 15.0})
        self.assertEqual([n for n, _ in asks], ["anthropic"])
        self.assertEqual(built, [("factory", 15.0), ("anthropic", None)])


class ReaderFallbacks(unittest.TestCase):
    def test_claude_reads_first(self):
        calls = []
        r = Reader([answering("anthropic", PAID, calls=calls), answering("factory", PAID, calls=calls)])
        reading = r.read(NOTE, "Kestrel Quant", "2026-03-07")
        self.assertEqual((reading.intent, reading.read_by, calls), ("already_paid", "anthropic", ["anthropic"]))

    def test_claude_failure_goes_to_factory(self):
        with self.assertLogs("desk_agents.seat2_llm", level="WARNING"):
            reading = Reader([answering("anthropic", error=DecisionUnavailable("stop_reason refusal")),
                              answering("factory", PAID)]).read(NOTE, "Kestrel Quant", "2026-03-07")
        self.assertEqual(reading.read_by, "factory")

    def test_answer_that_breaks_the_schema_goes_to_the_next_provider(self):
        with self.assertLogs("desk_agents.seat2_llm", level="WARNING"):
            reading = Reader([answering("anthropic", {"intent": "maybe_paid"}),
                              answering("factory", PAID)]).read(NOTE, "Kestrel Quant", "2026-03-07")
        self.assertEqual(reading.read_by, "factory")

    def test_no_provider_falls_back_to_keywords(self):
        reading = Reader([]).read(NOTE, "Kestrel Quant", "2026-03-07")
        self.assertEqual((reading.intent, reading.read_by), ("already_paid", "keywords"))

    def test_who_read_it_is_not_in_the_schema_the_model_sees(self):
        from desk_agents.pushback import SCHEMA
        self.assertFalse({"read_by", "_read_by"} & set(SCHEMA["properties"]))


if __name__ == "__main__":
    unittest.main()
