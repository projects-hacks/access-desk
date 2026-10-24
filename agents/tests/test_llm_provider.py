"""Provider selection, the fallback chain, and decisions made through it. All fakes."""

import asyncio
import json
import re
from pathlib import Path

import pytest
from test_credit_decide import books, request  # noqa: F401 (books is a fixture)
from test_credit_decide import scores as scores  # noqa: PLC0414

from desk_agents import llm
from desk_agents.agents.credit_analyst import plan
from desk_agents.config import settings
from desk_agents.credit import guardrails as g
from desk_agents.credit.decide import Reply, decide_company, evidence_ids
from desk_agents.exploit import judge as judge_mod
from desk_agents.llm.types import DecisionUnavailable

HERE = Path(__file__).parent


class Provider:
    """A fake provider: scripted outcomes, one per call (an exception is raised)."""

    def __init__(self, name, outcomes):
        self.name, self.outcomes, self.calls = name, list(outcomes), []

    def build(self, usage=None, **opts):
        return self

    def __call__(self, messages):
        self.calls.append(messages)
        o = self.outcomes[min(len(self.calls), len(self.outcomes)) - 1]
        if isinstance(o, Exception):
            raise o
        return Reply(o, [{"type": "text", "text": o}], provider=self.name, model=f"{self.name}-m")


@pytest.fixture
def wired(monkeypatch):
    def wire(primary, fallback="", **providers):
        monkeypatch.setattr(settings, "llm_provider", primary)
        monkeypatch.setattr(settings, "llm_fallback", fallback)
        monkeypatch.setattr(llm, "BUILDERS", {n: p.build for n, p in providers.items()})
    return wire


def test_default_is_anthropic_and_unchanged(monkeypatch):
    assert settings.llm_provider == "anthropic"
    assert llm.provider_chain() == ["anthropic"]
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    assert llm.get_ask() is None  # no key: the rules decide, as before
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-test")
    assert llm.get_ask() is not None


def test_chain_order_and_cleanup(monkeypatch):
    monkeypatch.setattr(settings, "llm_provider", "factory")
    monkeypatch.setattr(settings, "llm_fallback", " anthropic , factory,bogus")
    assert llm.provider_chain() == ["factory", "anthropic"]
    monkeypatch.setattr(settings, "llm_fallback", "")
    assert llm.provider_chain() == ["factory"]


def test_first_provider_answers_and_the_second_is_not_called(wired):
    a, b = Provider("factory", ["{}"]), Provider("anthropic", ["{}"])
    wired("factory", "anthropic", factory=a, anthropic=b)
    assert llm.get_ask()([{"role": "user", "content": "x"}]).provider == "factory"
    assert (len(a.calls), len(b.calls)) == (1, 0)


@pytest.mark.parametrize("failure", [DecisionUnavailable("timeout"), RuntimeError("boom")])
def test_failure_hands_over_to_the_next_provider(wired, failure):
    a, b = Provider("factory", [failure]), Provider("anthropic", ["{}"])
    wired("factory", "anthropic", factory=a, anthropic=b)
    assert llm.get_ask()([{"role": "user", "content": "x"}]).provider == "anthropic"


def test_all_failing_propagates(wired):
    a = Provider("factory", [DecisionUnavailable("a")])
    b = Provider("anthropic", [DecisionUnavailable("b")])
    wired("factory", "anthropic", factory=a, anthropic=b)
    with pytest.raises(DecisionUnavailable, match="b"):
        llm.get_ask()([{"role": "user", "content": "x"}])


def test_unavailable_providers_are_skipped(wired):
    class Gone(Provider):
        def build(self, usage=None, **opts):
            return None

    b = Provider("anthropic", ["{}"])
    wired("factory", "anthropic", factory=Gone("factory", []), anthropic=b)
    assert llm.get_ask() is b
    wired("factory", "", factory=Gone("factory", []), anthropic=b)
    assert llm.get_ask() is None


def test_explicit_provider_ignores_the_chain(wired):
    a, b = Provider("factory", ["{}"]), Provider("anthropic", ["{}"])
    wired("factory", "anthropic", factory=a, anthropic=b)
    assert llm.get_ask("anthropic") is b


# ── Decisions through the chain ─────────────────────────────────────────────


def good(r):
    """A decision the guardrails accept: the baseline's own, citing real invoices."""
    d = g.from_baseline(r.baseline)
    d.cited_invoice_ids = sorted(evidence_ids(r.book))[:2]
    return d.model_dump_json()


KESTREL = "ORG-90412"


@pytest.mark.parametrize("first", [
    DecisionUnavailable("timed out"),
    DecisionUnavailable("droid answer was not JSON"),
    DecisionUnavailable("droid returned no answer"),
    DecisionUnavailable("droid error: refused"),
])
def test_a_failing_provider_falls_to_the_next_then_the_rules(wired, books, scores, first):  # noqa: F811
    r = request(books, scores, KESTREL)
    a, b = Provider("factory", [first]), Provider("anthropic", [good(r)])
    wired("factory", "anthropic", factory=a, anthropic=b)
    o = decide_company(r, llm.get_ask())
    assert (o.decided_by, o.provider, o.model) == ("claude", "anthropic", "anthropic-m")

    a, b = Provider("factory", [first]), Provider("anthropic", [first])
    wired("factory", "anthropic", factory=a, anthropic=b)
    o = decide_company(r, llm.get_ask())
    assert (o.decided_by, o.provider) == ("rules", "rules")
    assert o.final == r.baseline


def test_invalid_schema_retries_with_the_violations_then_the_rules(wired, books, scores):  # noqa: F811
    r = request(books, scores, KESTREL)
    bad = json.dumps({"action": "stay"})
    a = Provider("factory", [bad, bad])
    wired("factory", "", factory=a)
    o = decide_company(r, llm.get_ask())
    assert o.provider == "rules"
    assert len(a.calls) == 2
    retry = a.calls[1][-1]["content"]
    assert "rejected" in retry and "schema" in retry


def test_rules_decided_outcomes_say_so(books, scores):  # noqa: F811
    o = decide_company(request(books, scores, KESTREL), None)
    assert (o.decided_by, o.provider) == ("rules", "rules")


# ── The whole decision flow with LLM_PROVIDER=factory and a fake Droid ──────


def test_full_plan_through_factory_provider(monkeypatch, books):  # noqa: F811
    from desk_agents.llm import factory

    baselines = {cid: o for cid, o in plan(books, [], []).outcomes.items()}
    by_id = {b.client.id: b for b in books}
    prompts = []

    class Droid:
        """Answers each prompt with the baseline decision for the company it names."""

        def __init__(self, **kw):
            self.text = ""
            self.sent = asyncio.Event()

        async def connect(self):
            pass

        async def initialize_session(self, **kw):
            pass

        async def add_user_message(self, *, text, output_format):
            prompts.append(text)
            cid = re.search(r'"id": "(ORG-\d+)"', text).group(1)
            d = g.from_baseline(baselines[cid].baseline)
            d.cited_invoice_ids = sorted(evidence_ids(by_id[cid]))[:2]
            self.text = d.model_dump_json()
            self.sent.set()

        async def receive_response(self):
            await self.sent.wait()
            yield Delta(self.text)
            yield Done()

        async def close(self):
            pass

    from test_llm_factory import Delta, Done, Effort, Err, Level

    sdk = type("S", (), {
        "DroidClient": Droid, "AutonomyLevel": Level, "ReasoningEffort": Effort,
        "AssistantTextDelta": Delta, "ErrorEvent": Err, "TurnComplete": Done})
    monkeypatch.setattr(factory, "_load_sdk", lambda: sdk)
    monkeypatch.setattr(factory.shutil, "which", lambda n: "/usr/bin/droid")
    monkeypatch.setattr(settings, "factory_api_key", "fk-test")
    monkeypatch.setattr(settings, "llm_provider", "factory")
    monkeypatch.setattr(settings, "anthropic_api_key", None)

    p = plan(books, [], [], ask=llm.get_ask())
    assert prompts, "Droid was never asked"
    # Droid answered with each baseline, so every company ends where the rules put it.
    assert {cid: d for cid, d in p.decisions.items()} == {
        cid: o.baseline for cid, o in baselines.items()}
    assert {o.provider for o in p.outcomes.values()} <= {"factory", "rules"}
    assert any(o.provider == "factory" for o in p.outcomes.values())
    assert all(x.proposal["provider"] in ("factory", "rules") for x in p.proposals)
    assert {x.proposal["provider"] for x in p.proposals if x.proposal["decided_by"] == "claude"} \
        <= {"factory"}


# ── ExploitWatch's judge ────────────────────────────────────────────────────


def test_judge_default_ask_goes_through_the_provider_chain(wired, monkeypatch):
    a = Provider("factory", ['{"verdicts": []}'])
    wired("factory", "", factory=a)
    ask = judge_mod.default_ask()
    assert ask("the prompt") == '{"verdicts": []}'
    assert a.calls == [[{"role": "user", "content": "the prompt"}]]


def test_judge_default_ask_is_none_when_nothing_is_usable(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    assert judge_mod.default_ask() is None
