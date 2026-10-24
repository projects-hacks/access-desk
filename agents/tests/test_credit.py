"""
Credit analyst on Rajeev's dataset (tests/fixtures/book.json, from `pnpm credit:fixture`).
The answer key is the Seat 1 build plan's "Expected results and tests".
"""

from datetime import date
from pathlib import Path

import pytest

from desk_agents.agents.credit_analyst import plan
from desk_agents.credit.detectors import detect
from desk_agents.credit.load import load_books_from_json
from desk_agents.credit.model import ClientBook, Dispute, Payment
from desk_agents.credit.scoring import reliability, score_all
from desk_agents.credit.tiers import decide

FIXTURE = Path(__file__).parent / "fixtures" / "book.json"

# client -> (tier now, expected: "stay" | "review" | new tier)
KEY: dict[str, tuple[int, str | int]] = {
    "ORG-90101": (1, "review"),  # Halcyon
    "ORG-90107": (1, "stay"),  # Redwing
    "ORG-90118": (1, "stay"),  # Aster Point
    "ORG-90142": (2, 1),  # Meridian Flow
    "ORG-90164": (2, 1),  # Silverline
    "ORG-90176": (3, "stay"),  # Northfold
    "ORG-90229": (2, 3),  # Fieldstone
    "ORG-90233": (2, "stay"),  # Bluefin
    "ORG-90244": (2, "stay"),  # Basalt
    "ORG-90251": (2, "stay"),  # Cinder Peak
    "ORG-90287": (2, "stay"),  # Tidewater
    "ORG-90302": (2, "stay"),  # Polaris
    "ORG-90355": (3, "stay"),  # Cobalt Ridge: held by the 3-point margin
    "ORG-90366": (2, "stay"),  # Copperline
    "ORG-90378": (3, 2),  # Harbor & Pine
    "ORG-90391": (3, 2),  # Granite Bay
    "ORG-90399": (3, 2),  # Larkspur
    "ORG-90412": (3, "stay"),  # Kestrel: recent_late
    "ORG-90431": (3, "stay"),  # Ostrava: held by margin
    "ORG-90455": (4, "stay"),  # Ember Street: held by margin
    "ORG-90463": (3, "stay"),  # Ivory Lane: one miss, no flag
    "ORG-90518": (3, 5),  # Orchard: dispute_delay
    "ORG-90612": (4, "stay"),  # Saltmarsh
    "ORG-90677": (4, "stay"),  # Juniper: restriction_eve
    "ORG-90689": (3, 2),  # Quillon
    "ORG-90731": (3, "stay"),  # Lantern
    "ORG-90744": (4, 5),  # Wrenfield: partial_reset
    "ORG-90758": (4, "stay"),  # Monarch: pays_restricted_only
    "ORG-90802": (5, "stay"),  # Vantage Loop
    "ORG-90816": (5, "stay"),  # Tessellate
}

# Fieldstone's recent_late only fires once the 2026-03-02 lump sum is applied (not in the fixture).
FLAGS = {
    "quarter_end:ORG-90101",
    "recent_late:ORG-90412",
    "dispute_delay:ORG-90518",
    "restriction_eve:ORG-90677",
    "partial_reset:ORG-90744",
    "pays_restricted_only:ORG-90758",
}

# Approximate scores from the plan (reliability, value).
SCORES = {
    "ORG-90101": (53, 98), "ORG-90518": (42, 40), "ORG-90677": (65, 44),
    "ORG-90412": (80, 73), "ORG-90142": (93, 84),
}


@pytest.fixture(scope="module")
def books() -> list[ClientBook]:
    return load_books_from_json(FIXTURE)


@pytest.fixture(scope="module")
def result(books):
    return plan(books, [], [])


def by_id(books: list[ClientBook], client_id: str) -> ClientBook:
    return next(b for b in books if b.client.id == client_id)


def test_fixture_is_the_demo_morning(books):
    assert len(books) == 30
    assert {b.today for b in books} == {date(2026, 3, 3)}
    assert {b.client.id: b.client.tier for b in books} == {k: v[0] for k, v in KEY.items()}


@pytest.mark.parametrize("client_id", sorted(KEY))
def test_tier_matches_the_answer_key(result, client_id):
    d = result.decisions[client_id]
    expected = KEY[client_id][1]
    got = d.to_tier if d.action == "tier_change" else d.action
    assert got == expected, (d.reasons, result.scores[client_id].breakdown)


def test_nine_changes_and_one_review(result):
    actions = [d.action for d in result.decisions.values()]
    assert actions.count("tier_change") == 9
    assert actions.count("review") == 1
    assert actions.count("stay") == 20


def test_exactly_the_planted_flags(result):
    fired = {f"{f.pattern}:{cid}" for cid, fl in result.flags.items() for f in fl if f.fired}
    assert fired == FLAGS


def test_flag_evidence_matches_the_plan(result):
    measured = {f.pattern: f for fl in result.flags.values() for f in fl if f.fired}
    assert measured["restriction_eve"].measured.startswith("14 of 14 ")
    assert len(measured["partial_reset"].evidence) == 11
    assert "API day 2, CUSTODY day 30" in measured["pays_restricted_only"].measured
    assert measured["recent_late"].measured.startswith("last 3 months 12, 18, 9 days late")
    assert measured["dispute_delay"].measured.startswith("11 of 11 months disputed, 22 of 22")


@pytest.mark.parametrize("client_id", sorted(SCORES))
def test_scores_near_the_plan(result, client_id):
    rel, val = SCORES[client_id]
    s = result.scores[client_id]
    assert abs(s.reliability - rel) <= 1.5
    assert abs(s.value - val) <= 1.5


def test_same_input_gives_identical_output(books):
    a, b = plan(books, [], []), plan(books, [], [])
    assert [p.model_dump() for p in a.proposals] == [p.model_dump() for p in b.proposals]
    assert a.profiles == b.profiles and a.flag_rows == b.flag_rows


def test_strategic_clients_never_get_a_tier_change(result, books):
    for b in books:
        if b.client.strategic:
            assert result.decisions[b.client.id].action != "tier_change"
    assert result.decisions["ORG-90101"].action == "review"
    assert result.decisions["ORG-90101"].policy_ref == "pol-022"


def test_kestrel_not_upgraded_while_recent_late(books, result):
    assert result.decisions["ORG-90412"].action == "stay"
    # At tier 4 its formula (3) would be an upgrade; recent_late blocks it.
    kestrel = by_id(books, "ORG-90412")
    higher = kestrel.model_copy(update={"client": kestrel.client.model_copy(update={"tier": 4})})
    d = decide(higher, result.scores["ORG-90412"], result.flags["ORG-90412"])
    assert (d.formula, d.action) == (3, "stay")
    assert "upgrade blocked: recent_late fired" in d.reasons


@pytest.mark.parametrize("client_id", ["ORG-90355", "ORG-90431", "ORG-90455"])
def test_held_by_the_three_point_margin(result, client_id):
    d = result.decisions[client_id]
    assert d.formula < d.current and d.action == "stay"
    assert any("within 3 points" in r for r in d.reasons)


def _with_dispute(book: ClientBook, resolution: str) -> ClientBook:
    inv = next(i for i in book.invoices if i.status == "paid")
    extra = Dispute(id="DSP-T", invoice_id=inv.id, opened_on=inv.due_on, resolved_on=inv.due_on,
                    resolution=resolution, status="resolved")
    return book.model_copy(update={"disputes": [*book.disputes, extra]})


def test_credited_dispute_costs_nothing_no_change_costs_one_and_a_half(books):
    meridian = by_id(books, "ORG-90142")
    _, base = reliability(meridian)
    _, credited = reliability(_with_dispute(meridian, "credited"))
    _, upheld = reliability(_with_dispute(meridian, "no_change"))
    assert credited["disputes"] == base["disputes"] == 0
    assert upheld["disputes"] == 1.5


def test_replay_reads_nothing_after_today(books):
    replay = load_books_from_json(FIXTURE, today=date(2025, 12, 31))
    cutoff = date(2025, 12, 31)
    for b in replay:
        assert b.today == cutoff
        for i in b.invoices:
            assert i.issued_on <= cutoff
            assert all(p.value_on <= cutoff for p in i.payments)
            assert i.paid_on is None or i.paid_on <= cutoff
        for d in b.disputes:
            assert d.opened_on <= cutoff
            assert d.resolved_on is None or d.resolved_on <= cutoff
    # Every January payment in the live book really is gone from the replay.
    assert any(p.value_on.year == 2026 for b in books for i in b.invoices for p in i.payments)
    assert plan(replay, [], []).scores  # scores without error


def test_second_run_proposes_nothing_new(books, result):
    open_items = [
        {"id": n, "kind": p.kind.value, "client_id": p.client_id, "subject_id": p.subject_id,
         "state": "PROPOSED"}
        for n, p in enumerate(result.proposals, start=1)
    ]
    again = plan(books, open_items, [])
    assert again.proposals == []
    assert again.withdraw == []
    kinds = [p.kind.value for p in result.proposals]
    assert kinds.count("CREDIT_REVIEW") == 10 and kinds.count("EXPLOIT_FLAG") == 6


def test_rejection_is_remembered_for_30_sim_days(books, result):
    orchard = next(p for p in result.proposals if p.subject_id == "tier:ORG-90518:3->5")
    items = [{"id": 7, "kind": "CREDIT_REVIEW", "client_id": "ORG-90518",
              "subject_id": orchard.subject_id, "state": "REJECTED"}]

    def precedent(on: str):
        return [{"id": "PRC-L7", "work_item_id": 7, "decided_on": on, "decision": "Rejected",
                 "source": "live"}]

    recent = plan(books, items, precedent("2026-02-20")).proposals
    stale = plan(books, items, precedent("2026-01-20")).proposals
    assert orchard.subject_id not in {p.subject_id for p in recent}
    assert orchard.subject_id in {p.subject_id for p in stale}


def test_proposals_carry_what_the_controller_needs(result):
    orchard = next(p for p in result.proposals if p.subject_id == "tier:ORG-90518:3->5")
    assert orchard.title == "Orchard Treasury: tier 3 → 5"
    assert orchard.policy_ref == "pol-020" and orchard.required_role.value == "CONTROLLER"
    assert set(orchard.proposal) == {
        "action", "from_tier", "to_tier", "reliability", "value", "coverage_ratio", "breakdown",
        "flags", "expected_settle_on",
    }
    assert orchard.proposal["flags"] == ["dispute_delay"]
    assert "dispute_delay" in orchard.reasoning  # template reasoning cites the flag
    halcyon = next(p for p in result.proposals if p.subject_id == "review:ORG-90101")
    assert halcyon.title == "Halcyon Capital: review strategic tier"


def test_profiles_are_whole_scores_for_every_client(result):
    assert len(result.profiles) == 30
    for row in result.profiles:
        assert 0 <= row["reliability_score"] <= 100 and 0 <= row["value_score"] <= 100
    flags = {r["id"]: r for r in result.flag_rows}
    assert flags["quarter_end:ORG-90101"]["status"] == "watch"  # strategic
    assert flags["dispute_delay:ORG-90518"]["status"] == "flagged"


def test_fieldstone_slide_after_the_lump_sum():
    """Payment checking applies the 2026-03-02 catch-up wire: recent_late fires, still 2 -> 3."""
    books = load_books_from_json(FIXTURE)
    fieldstone = by_id(books, "ORG-90229")
    paid = []
    for i in fieldstone.invoices:
        if i.status == "open" and i.period != "2026-02":
            i = i.model_copy(update={
                "paid_cents": i.amount_cents, "paid_on": date(2026, 3, 2), "status": "paid",
                "payments": [Payment(value_on=date(2026, 3, 2), amount_cents=i.amount_cents)],
            })
        paid.append(i)
    after = fieldstone.model_copy(update={"invoices": paid})
    books = [after if b.client.id == "ORG-90229" else b for b in books]
    scores = score_all(books)
    flags = detect(after)
    assert [f.pattern for f in flags if f.fired] == ["recent_late"]
    d = decide(after, scores["ORG-90229"], flags)
    assert (d.action, d.to_tier) == ("tier_change", 3)
