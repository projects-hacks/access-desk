"""The provider gate scores a fake provider on the fixture book; no network."""

import json
import re
import sys
import threading
import types
from datetime import date
from pathlib import Path

import pytest

from desk_agents.credit import __main__ as cli
from desk_agents.credit.backtest import backtest_claude, month_ends
from desk_agents.credit.decide import Reply
from desk_agents.credit.evalprovider import cost_usd, evaluate_provider, render
from desk_agents.credit.load import load_books_from_json

FIXTURE = Path(__file__).parent / "fixtures" / "book.json"


@pytest.fixture(scope="module")
def books():
    return load_books_from_json(FIXTURE)


class Usage:
    def __init__(self, i: int, o: int):
        self.input_tokens, self.output_tokens = i, o


class Fake:
    """mode: stay (valid) | review (valid, differs from rules) | bad (never valid)
    | first_bad (bad first try, valid on retry) | flip (stay/review alternating per client)."""

    def __init__(self, mode: str, usage: list | None = None):
        self.mode, self.usage, self.n = mode, usage, {}
        self.lock = threading.Lock()

    def __call__(self, messages: list[dict]) -> Reply:
        text0 = messages[0]["content"]
        cid = re.search(r'"id": "(ORG-\d+)"', text0).group(1)
        tier = int(re.search(r'"current_tier": (\d)', text0).group(1))
        with self.lock:
            k = self.n[cid] = self.n.get(cid, 0) + 1
            if self.usage is not None:
                self.usage.append(Usage(1000, 100))
        mode = self.mode
        if mode == "bad" or (mode == "first_bad" and len(messages) == 1):
            return Reply("not json", [{"type": "text", "text": "not json"}])
        action = "review" if mode == "review" or (mode == "flip" and k % 2 == 0) else "stay"
        text = json.dumps({"action": action, "to_tier": tier, "policy": None, "reasons": ["ok"],
                           "cited_invoice_ids": [], "confidence": 0.8})
        return Reply(text, [{"type": "text", "text": text}])


def run(books, mode, **kw):
    cutoffs = month_ends(date(2025, 9, 1), books[0].today)
    usage: list = []
    return evaluate_provider(books, cutoffs, Fake(mode, usage), usage=usage, **kw)


def status(r, name):
    return next(c["status"] for c in r["checks"] if c["check"].startswith(name))


def test_valid_stable_provider_passes_what_it_can(books):
    r = run(books, "stay", prices={"input": 4.0, "output": 20.0})
    assert r["asked"] > 0 and r["accepted"] == r["asked"]
    assert status(r, "valid") == "PASS" and status(r, "repeat") == "PASS"
    assert r["repeat_identical"] == r["repeat_clients"] > 0
    assert status(r, "full cycle") == "PASS" and status(r, "cost") == "INFO"
    assert r["cost_usd"] == pytest.approx(
        r["tokens"]["input"] * 4 / 1e6 + r["tokens"]["output"] * 20 / 1e6, abs=1e-4)
    assert "GATE:" in render(r)


def test_numbers_match_the_backtest(books):
    cutoffs = month_ends(date(2025, 9, 1), books[0].today)
    bt = backtest_claude(books, cutoffs, Fake("review"))
    r = run(books, "review")
    assert r["disagree"] == bt["disagree"] > 0
    assert r["right_when_differs"] == bt["claude_right_when_disagree"]


def test_never_valid_fails_the_valid_share(books):
    r = run(books, "bad")
    assert r["accepted"] == 0 and status(r, "valid") == "FAIL" and not r["passed"]


def test_valid_on_the_second_try_counts(books):
    r = run(books, "first_bad")
    assert r["asked"] > 0 and r["accepted"] == r["asked"]


def test_flipping_provider_fails_repeatability(books):
    r = run(books, "flip")
    assert r["repeat_identical"] < r["repeat_clients"]
    assert status(r, "repeat") == "FAIL"


def test_slow_cycle_fails(books):
    ticks = iter(range(0, 10_000, 100))
    cutoffs = month_ends(date(2025, 9, 1), books[0].today)
    r = evaluate_provider(books, cutoffs, Fake("stay"), clock=lambda: float(next(ticks)))
    assert status(r, "full cycle") == "FAIL"


def test_unknown_price_prints_unknown(books):
    r = run(books, "stay")
    assert r["cost_usd"] is None
    assert "unknown" in render(r)
    assert cost_usd([Usage(1_000_000, 0)], {"input": 4.0, "output": 20.0}) == 4.0


def test_cli_exits_2_when_the_provider_is_unavailable(monkeypatch, capsys):
    fake_llm = types.ModuleType("desk_agents.llm")
    fake_llm.get_ask = lambda provider=None, usage=None: None
    monkeypatch.setitem(sys.modules, "desk_agents.llm", fake_llm)
    monkeypatch.setattr(sys, "argv", ["credit", "eval-provider", "factory", "--books",
                                      str(FIXTURE)])
    with pytest.raises(SystemExit) as e:
        cli.main()
    assert e.value.code == 2
    assert "not available" in capsys.readouterr().out
