"""A tier Claude keeps against the rules' proposal is recorded once, with its reason."""

from pathlib import Path

import pytest
from test_credit_decide import MERIDIAN, FakeClaude, decision

from desk_agents.agents.credit_analyst import CreditAnalyst, plan
from desk_agents.credit.load import load_books_from_json

FIXTURE = Path(__file__).parent / "fixtures" / "book.json"


@pytest.fixture(scope="module")
def books():
    return load_books_from_json(FIXTURE)


def kept_plan(books):
    fake = FakeClaude({MERIDIAN: [decision("stay", 2, reasons=("Too early to move it up.",))]})
    return plan(books, [], [], ask=fake)


def test_a_kept_tier_is_listed_with_the_rules_proposal_and_claudes_reason(books):
    p = kept_plan(books)
    assert [k[0] for k in p.kept] == [MERIDIAN]
    _, code, reason = p.kept[0]
    assert code == "claude_kept_tier:tier_change:1"
    assert reason.startswith("Claude kept tier 2; the rules proposed tier 2 -> 1.")
    assert "Too early to move it up." in reason
    assert not [x for x in p.proposals if x.client_id == MERIDIAN]  # and nothing is filed for it


def test_agreeing_with_the_rules_or_falling_back_is_not_a_kept_tier(books):
    assert plan(books, [], []).kept == []  # no model: the rules decided
    upgrade = FakeClaude({MERIDIAN: [decision("tier_change", 1, cited=("INV-1",))]})
    # An invalid citation falls back to the rules, which is not Claude keeping anything.
    assert plan(books, [], [], ask=upgrade).kept == []


class FakeDb:
    def __init__(self, audit=()):
        self.audit, self.waits = list(audit), []

    def record_wait(self, cid, code, reason):
        self.waits.append((cid, code, reason))
        self.audit.append({"action": "AGENT_WAITED", "client_id": cid, "to_state": code})

    def sql(self, query):
        return self.audit


def test_recorded_once_even_across_restarts(books):
    kept = kept_plan(books).kept
    db = FakeDb()
    agent = CreditAnalyst.__new__(CreditAnalyst)
    agent.db = db
    agent._record_kept(kept)
    agent._record_kept(kept)  # next cycle
    assert len(db.waits) == 1
    other = CreditAnalyst.__new__(CreditAnalyst)  # restarted process: only the audit log remembers
    other.db = db
    other._record_kept(kept)
    assert len(db.waits) == 1
