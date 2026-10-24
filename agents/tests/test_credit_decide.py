"""
Claude decides per company within the guardrails; the rules are the fallback.
Every Claude call here is a fake: nothing touches the network.
"""

import json
import re
import threading
from datetime import date
from pathlib import Path

import pytest
from test_credit import KEY

from desk_agents.agents.credit_analyst import flags_from_table, plan
from desk_agents.credit import guardrails as g
from desk_agents.credit.company import evaluate, parse_policies
from desk_agents.credit.decide import Reply, Request, attention, decide_company, evidence_ids
from desk_agents.credit.detectors import detect
from desk_agents.credit.load import load_books_from_json
from desk_agents.credit.scoring import score_all
from desk_agents.credit.tiers import decide

FIXTURE = Path(__file__).parent / "fixtures" / "book.json"
HALCYON, MERIDIAN, KESTREL, JUNIPER, IVORY = (
    "ORG-90101", "ORG-90142", "ORG-90412", "ORG-90677", "ORG-90463")


class FakeClaude:
    """Scripted replies per client (one per attempt); clients without a script get an error."""

    def __init__(self, script: dict[str, list[dict]]):
        self.script = script
        self.calls: list[tuple[str, list[dict]]] = []
        self.lock = threading.Lock()

    def __call__(self, messages: list[dict]) -> Reply:
        cid = re.search(r'"id": "(ORG-\d+)"', messages[0]["content"]).group(1)
        with self.lock:
            self.calls.append((cid, messages))
        replies = self.script.get(cid)
        if not replies:
            raise TimeoutError("no scripted reply")
        attempt = len(messages) // 2
        text = json.dumps(replies[min(attempt, len(replies) - 1)])
        return Reply(text, [{"type": "text", "text": text}])

    def clients(self) -> list[str]:
        return sorted(c for c, _ in self.calls)


def decision(action="stay", to_tier=1, policy=None, cited=(), reasons=("because",), conf=0.8):
    return {"action": action, "to_tier": to_tier, "policy": policy, "reasons": list(reasons),
            "cited_invoice_ids": list(cited), "confidence": conf}


def draft(policy_id="pol-020", title="Prepay on the due date", terms=None, criteria=None):
    return {
        "kind": "company_draft", "policy_id": policy_id, "title": title,
        "terms": terms if terms is not None else [
            {"lever": "prepay", "value": None, "at_renewal": False},
            {"lever": "cure_days", "value": 5, "at_renewal": True},
        ],
        "success_criteria": criteria if criteria is not None else [
            {"metric": "share_paid_within_grace", "target": 0.8, "pattern": None,
             "window_months": 3},
            {"metric": "pattern_not_firing", "target": 0, "pattern": "restriction_eve",
             "window_months": 6},
        ],
    }


@pytest.fixture(scope="module")
def books():
    return load_books_from_json(FIXTURE)


@pytest.fixture(scope="module")
def scores(books):
    return score_all(books)


def book_of(books, cid):
    return next(b for b in books if b.client.id == cid)


def request(books, scores, cid, **ctx):
    from desk_agents.credit.decide import CompanyContext

    b = book_of(books, cid)
    f = detect(b)
    return Request(b, scores[cid], f, decide(b, scores[cid], f), CompanyContext(**ctx))


def answers(p):
    return {cid: (d.to_tier if d.action == "tier_change" else d.action)
            for cid, d in p.decisions.items()}


# ── Fallback reproduces the answer key ──────────────────────────────────────


def test_no_key_is_the_answer_key_and_never_calls(books):
    p = plan(books, [], [])
    assert answers(p) == {cid: v[1] for cid, v in KEY.items()}
    assert {o.decided_by for o in p.outcomes.values()} == {"rules"}


def test_failing_claude_falls_back_to_the_answer_key(books):
    fake = FakeClaude({})  # every call raises
    p = plan(books, [], [], ask=fake)
    assert answers(p) == {cid: v[1] for cid, v in KEY.items()}
    assert {o.decided_by for o in p.outcomes.values()} == {"rules"}
    # Only companies where something happens are asked: 10 proposals + 3 flagged stays.
    assert fake.clients() == sorted({
        *(p.subject_id.split(":")[1] for p in p.proposals), KESTREL, JUNIPER, "ORG-90758"})
    assert len(fake.calls) == 13  # one each: an outage isn't retried
    assert [x.kind.value for x in p.proposals] == ["CREDIT_REVIEW"] * 10
    assert all(x.proposal["decided_by"] == "rules" for x in p.proposals)


def test_baseline_respects_the_tier_guardrails(books, scores):
    for b in books:
        r = request(books, scores, b.client.id)
        v = g.violations(b, r.scores, r.flags, r.baseline, g.from_baseline(r.baseline),
                         evidence_ids(b), {"pol-020", "pol-021", "pol-022"})
        assert [x for x in v if not x.startswith("citations")] == [], b.client.name


# ── Guardrails reject, retry once, then fall back ───────────────────────────


@pytest.mark.parametrize(("cid", "bad", "rule"), [
    (HALCYON, decision("tier_change", 2, cited=["INV-1001"]), "strategic"),
    (MERIDIAN, decision("tier_change", 5, cited=["INV-1001"]), "max_down"),
    (MERIDIAN, decision("stay", 2, cited=["INV-9999"]), "citations"),
    (KESTREL, decision("stay", 3, policy=draft(), cited=["INV-1001"]), "lever_prepay"),
    (KESTREL, decision("tier_change", 2, cited=["INV-1001"]), "recent_late"),
    (JUNIPER, decision("tier_change", 3, policy=draft(terms=[
        {"lever": "grace_days", "value": 30, "at_renewal": False}]), cited=["INV-1001"]),
     "lever_grace"),
])
def test_guardrail_breaking_decision_is_retried_then_falls_back(books, scores, cid, bad, rule):
    r = request(books, scores, cid)
    bad = {**bad, "cited_invoice_ids": [
        i if i == "INV-9999" else r.book.invoices[0].id for i in bad["cited_invoice_ids"]]}
    fake = FakeClaude({cid: [bad, bad]})
    o = decide_company(r, fake)
    assert o.decided_by == "rules" and o.final == r.baseline
    assert len(fake.calls) == 2 and len(o.attempts) == 2
    assert any(v.startswith(rule) for v in o.attempts[0].violations), o.attempts[0].violations
    retry = fake.calls[1][1][-1]["content"]
    assert retry.startswith("That decision was rejected") and rule in retry


def test_a_fixed_retry_is_accepted(books, scores):
    r = request(books, scores, MERIDIAN)
    inv = r.book.invoices[-4].id
    fake = FakeClaude({MERIDIAN: [decision("tier_change", 5, cited=[inv]),
                                  decision("stay", 2, cited=[inv], reasons=["hold a quarter"])]})
    o = decide_company(r, fake)
    assert o.decided_by == "claude" and o.final.action == "stay"
    assert o.attempts[0].violations and not o.attempts[1].violations


def test_invalid_json_counts_as_a_violation(books, scores):
    r = request(books, scores, MERIDIAN)
    fake = FakeClaude({MERIDIAN: [{"action": "upgrade"}, {"nope": 1}]})
    o = decide_company(r, fake)
    assert o.decided_by == "rules" and o.attempts[0].error == "invalid JSON"


def test_quiet_company_gets_no_call(books, scores):
    r = request(books, scores, "ORG-90107")  # Redwing: stays, no flags
    assert attention(r.baseline, r.flags, r.ctx) is None
    fake = FakeClaude({})
    assert decide_company(r, fake).decided_by == "rules" and fake.calls == []


# ── Claude's choice and company policies ────────────────────────────────────


def juniper_reply(books):
    juniper = book_of(books, JUNIPER)
    ids = [i.id for i in juniper.invoices if i.status == "paid"][-6:]
    return decision("stay", 4, policy=draft(), cited=ids, conf=0.85, reasons=[
        "14 of 14 single payments landed on day 20, the day before restriction.",
        "A lower tier doesn't change that; prepay and a 5-day cure at renewal do.",
    ])


def test_claude_choice_replaces_the_baseline_and_drafts_a_policy(books):
    fake = FakeClaude({JUNIPER: [juniper_reply(books)]})
    p = plan(books, [], [], ask=fake)
    o = p.outcomes[JUNIPER]
    assert o.decided_by == "claude" and o.final.action == "stay"
    assert p.policy_rows == [{
        "policy_id": f"pol-020:{JUNIPER}", "version": 1, "status": "draft",
        "title": "Prepay on the due date", "rule_json": p.policy_rows[0]["rule_json"],
        "learned_from": p.policy_rows[0]["learned_from"],
    }]
    rule = json.loads(p.policy_rows[0]["rule_json"])
    assert rule["terms"][0]["lever"] == "prepay" and rule["success_criteria"][0]["target"] == 0.8
    drafts = [x for x in p.proposals if x.kind.value == "POLICY_DRAFT"]
    assert len(drafts) == 1
    d = drafts[0]
    assert d.subject_id == f"policy:pol-020:{JUNIPER}@1" and d.required_role.value == "CONTROLLER"
    assert d.proposal["decided_by"] == "claude" and d.proposal["policy_key"] == f"pol-020:{JUNIPER}@1"
    assert d.proposal["baseline"]["action"] == "stay"
    assert "flag cap: restriction_eve fired, tier no better than 3" in d.proposal["guardrails"]
    # Everyone else fell back (the fake raises for them); the answer key still holds there.
    assert len([x for x in p.proposals if x.kind.value == "CREDIT_REVIEW"]) == 10


def test_claude_tier_change_carries_both_views(books):
    meridian = book_of(books, MERIDIAN)
    inv = meridian.invoices[-4].id
    pol_022 = {"kind": "existing", "policy_id": "pol-022", "title": "", "terms": [],
               "success_criteria": []}
    halcyon_inv = book_of(books, HALCYON).invoices[0].id
    fake = FakeClaude({
        MERIDIAN: [decision("stay", 2, cited=[inv], reasons=["hold"])],
        HALCYON: [decision("review", 1, policy=pol_022, cited=[halcyon_inv])],
    })
    p = plan(books, [], [], ask=fake)
    assert p.decisions[MERIDIAN].action == "stay"  # Claude declined the upgrade
    assert "tier:ORG-90142:2->1" not in {x.subject_id for x in p.proposals}
    halcyon = next(x for x in p.proposals if x.subject_id == f"review:{HALCYON}")
    assert halcyon.proposal["decided_by"] == "claude"
    assert halcyon.proposal["choice"]["policy"]["policy_id"] == "pol-022"
    assert halcyon.proposal["baseline"]["action"] == "review"
    assert "The rules alone would propose a review" in halcyon.reasoning


def test_second_run_proposes_nothing_and_calls_nobody(books):
    fake = FakeClaude({JUNIPER: [juniper_reply(books)]})
    first = plan(books, [], [], ask=fake)
    items = [
        {"id": n, "kind": x.kind.value, "client_id": x.client_id, "subject_id": x.subject_id,
         "state": "PROPOSED", "proposal_json": json.dumps(x.proposal)}
        for n, x in enumerate(first.proposals, start=1)
    ]
    rows = [{**r, "key": f"{r['policy_id']}@{r['version']}", "approved_by": None}
            for r in first.policy_rows]
    again_fake = FakeClaude({JUNIPER: [juniper_reply(books)]})
    again = plan(books, items, [], policy_rows=rows, ask=again_fake)
    assert again.proposals == [] and again.withdraw == [] and again.policy_rows == []
    # Only the flagged stays without an open item are asked again (Kestrel, Monarch).
    assert again_fake.clients() == [KESTREL, "ORG-90758"]


def test_memo_skips_repeat_calls(books):
    memo: dict = {}
    fake = FakeClaude({JUNIPER: [juniper_reply(books)]})
    plan(books, [], [], ask=fake, memo=memo)
    n = len(fake.calls)
    plan(books, [], [], ask=fake, memo=memo)
    # Juniper's decision is remembered; outages aren't, so the others are asked again.
    assert JUNIPER not in [c for c, _ in fake.calls[n:]]


def test_next_version_after_an_active_one(books):
    rows = [{"key": f"pol-020:{JUNIPER}@1", "policy_id": f"pol-020:{JUNIPER}", "version": 1,
             "status": "active", "title": "x", "rule_json": json.dumps(
                 {"success_criteria": [], "effective_on": "2026-03-03"}),
             "learned_from": "", "approved_by": "controller"}]
    p = plan(books, [], [], policy_rows=rows, ask=FakeClaude({JUNIPER: [juniper_reply(books)]}))
    assert p.policy_rows[0]["version"] == 2


# ── Evaluator and the learning loop ─────────────────────────────────────────


def active(cid, criteria, effective_on, base="pol-020", version=1):
    return {"key": f"{base}:{cid}@{version}", "policy_id": f"{base}:{cid}", "version": version,
            "status": "active", "title": "company policy",
            "rule_json": json.dumps({"success_criteria": criteria, "effective_on": effective_on,
                                     "work_item_id": 41}),
            "learned_from": "", "approved_by": "controller"}


SHARE = {"metric": "share_paid_within_grace", "target": 0.8, "pattern": None, "window_months": 6}
MEAN = {"metric": "mean_days_late", "target": 25, "pattern": None, "window_months": 6}
WORST = {"metric": "max_days_late", "target": 10, "pattern": None, "window_months": 6}


def test_evaluator_is_deterministic(books):
    juniper, meridian = book_of(books, JUNIPER), book_of(books, MERIDIAN)
    (fail,) = parse_policies([active(JUNIPER, [SHARE, MEAN], "2025-11-01")])
    e = evaluate(juniper, fail)
    assert e.status == "failing"
    assert [r.passed for r in e.results] == [False, True]
    assert e.results[0].text.startswith("0 of 8 paid within 5 days")
    assert evaluate(juniper, fail) == e
    (ok,) = parse_policies([active(MERIDIAN, [SHARE], "2025-11-15")])
    assert evaluate(meridian, ok).status == "passing"
    (new,) = parse_policies([active(MERIDIAN, [SHARE], "2026-03-01")])
    assert evaluate(meridian, new).status == "pending"


def test_failing_policy_brings_a_quiet_company_back_to_claude(books):
    rows = [active(IVORY, [WORST], "2025-12-01")]
    fake = FakeClaude({})
    p = plan(books, [], [], policy_rows=rows, ask=fake)
    assert IVORY in fake.clients()
    prompt_text = next(m for c, m in fake.calls if c == IVORY)[0]["content"]
    assert '"status": "failing"' in prompt_text and "worst 41 days late" in prompt_text
    assert p.policy_outcomes == [(f"pol-020:{IVORY}@1", p.policy_outcomes[0][1])]
    assert p.policy_outcomes[0][1].startswith("failing on 2026-03-03: worst 41 days late")


# ── Flags come from ExploitWatch's table when it has rows ───────────────────


def test_flags_read_from_the_table(books):
    juniper = book_of(books, JUNIPER)
    ev = [{"invoice_id": juniper.invoices[0].id, "note": "paid on day 20"}]
    rows = [{"id": f"restriction_eve:{JUNIPER}", "client_id": JUNIPER,
             "pattern": "restriction_eve", "score": 1.0, "status": "flagged", "months": 14,
             "evidence_json": json.dumps(ev), "proposed_fix": "prepay"}]
    fl = flags_from_table(juniper, rows)
    assert [f.pattern for f in fl] == ["restriction_eve"] and fl[0].evidence[0].dpd >= 0
    cleared = [{**rows[0], "status": "cleared"}]
    p = plan(books, [], [], flag_rows=cleared)
    assert p.flags[JUNIPER] == []  # a cleared table row beats the fallback detector
    p = plan(books, [], [], flag_rows=rows)
    assert [f.pattern for f in p.flags[JUNIPER]] == ["restriction_eve"]
    # Clients with no table rows still get the detectors.
    assert [f.pattern for f in p.flags[KESTREL] if f.fired] == ["recent_late"]


def test_a_replay_falls_back_like_the_rules():
    replay = load_books_from_json(FIXTURE, today=date(2025, 12, 31))
    assert plan(replay, [], [], ask=FakeClaude({})).decisions == plan(replay, [], []).decisions
