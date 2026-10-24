import json
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from ..credit.detectors import detect
from ..credit.load import load_books
from ..credit.model import ClientBook, Flag, Scores, TierDecision
from ..credit.reasoning import explain
from ..credit.scoring import score_all
from ..credit.tiers import decide
from ..models import Proposal, Role, WorkItemKind
from .base import Agent

OPEN_STATES = {"PROPOSED", "NEEDS_INFO", "APPROVED", "POSTED"}
REJECTION_MEMORY_DAYS = 30


@dataclass
class Plan:
    """Everything one run writes: profiles and flags every time, proposals only when new."""

    scores: dict[str, Scores]
    flags: dict[str, list[Flag]]
    decisions: dict[str, TierDecision]
    profiles: list[dict[str, Any]] = field(default_factory=list)
    flag_rows: list[dict[str, Any]] = field(default_factory=list)
    proposals: list[Proposal] = field(default_factory=list)
    withdraw: list[int] = field(default_factory=list)


def subject_of(d: TierDecision) -> str | None:
    if d.action == "tier_change":
        return f"tier:{d.client_id}:{d.current}->{d.to_tier}"
    if d.action == "review":
        return f"review:{d.client_id}"
    return None


def plan(
    books: list[ClientBook],
    work_items: list[dict[str, Any]],
    precedents: list[dict[str, Any]],
    cleared_flags: frozenset[str] | set[str] = frozenset(),
    use_claude: bool = False,
) -> Plan:
    """Pure: score, detect, decide, and pick what isn't already proposed or recently rejected."""
    if not books:
        return Plan({}, {}, {})
    today = books[0].today
    scores = score_all(books)
    flags = {b.client.id: detect(b) for b in books}
    decisions = {b.client.id: decide(b, scores[b.client.id], flags[b.client.id]) for b in books}
    out = Plan(scores, flags, decisions)

    ours = [w for w in work_items if w["kind"] in ("CREDIT_REVIEW", "EXPLOIT_FLAG")]
    open_subjects = {w["subject_id"] for w in ours if w["state"] in OPEN_STATES}
    raised_flags = {w["subject_id"] for w in ours if w["kind"] == "EXPLOIT_FLAG"}
    subject_by_item = {int(w["id"]): w["subject_id"] for w in ours}
    recently_rejected = {
        subject_by_item.get(int(p["work_item_id"]))
        for p in precedents
        if p.get("source") == "live" and p.get("decision") == "Rejected"
        and p.get("work_item_id") is not None
        and date.fromisoformat(p["decided_on"]) > today - timedelta(days=REJECTION_MEMORY_DAYS)
    }

    for b in books:
        cid, s, fl, d = b.client.id, scores[b.client.id], flags[b.client.id], decisions[b.client.id]
        out.profiles.append({
            "client_id": cid,
            "value_score": _score(s.value),
            "reliability_score": _score(s.reliability),
            "coverage_ratio": round(s.coverage_ratio, 4),
            "coverage_detail": s.coverage_detail,
            "expected_settle_on": s.expected_settle_on.isoformat() if s.expected_settle_on
            else None,
        })
        for f in fl:
            if not f.fired:
                continue
            flag_id = f"{f.pattern}:{cid}"
            out.flag_rows.append({
                "id": flag_id, "client_id": cid, "pattern": f.pattern, "score": f.score,
                "status": "watch" if b.client.strategic else "flagged", "months": f.months,
                "evidence_json": json.dumps([e.model_dump(mode="json") for e in f.evidence]),
                "proposed_fix": f.proposed_fix,
            })
            subject = f"exploit:{f.pattern}:{cid}"
            if subject not in raised_flags and flag_id not in cleared_flags:
                out.proposals.append(_flag_proposal(b, s, f, subject))

        subject = subject_of(d)
        # A newer view of the same client supersedes its open review.
        out.withdraw += [
            int(w["id"]) for w in ours
            if w["kind"] == "CREDIT_REVIEW" and w["client_id"] == cid
            and w["state"] in ("PROPOSED", "NEEDS_INFO") and w["subject_id"] != subject
        ]
        if subject and subject not in open_subjects and subject not in recently_rejected:
            out.proposals.append(_review_proposal(b, s, fl, d, subject, use_claude))
    return out


def _score(x: float) -> int:
    return max(0, min(100, round(x)))


def _review_proposal(b: ClientBook, s: Scores, fl: list[Flag], d: TierDecision, subject: str,
                     use_claude: bool) -> Proposal:
    title = (
        f"{b.client.name}: tier {d.current} → {d.to_tier}" if d.action == "tier_change"
        else f"{b.client.name}: review strategic tier"
    )
    return Proposal(
        kind=WorkItemKind.CREDIT_REVIEW, client_id=b.client.id, subject_id=subject, title=title,
        amount_cents=s.exposure_cents, proposal=d.proposal(s, fl),
        reasoning=explain(d, s, fl, use_claude=use_claude), policy_ref=d.policy_ref,
        confidence=d.confidence, required_role=Role.CONTROLLER,
    )


def _flag_proposal(b: ClientBook, s: Scores, f: Flag, subject: str) -> Proposal:
    ids = [e.invoice_id for e in f.evidence]
    shown = ", ".join(ids[:8]) + (f" and {len(ids) - 8} more" if len(ids) > 8 else "")
    return Proposal(
        kind=WorkItemKind.EXPLOIT_FLAG, client_id=b.client.id, subject_id=subject,
        title=f"{b.client.name}: {f.pattern.replace('_', ' ')}",
        amount_cents=s.exposure_cents,
        proposal={
            "pattern": f.pattern, "measured": f.measured, "months": f.months, "score": f.score,
            "evidence_invoice_ids": ids, "proposed_fix": f.proposed_fix,
            "status": "watch" if b.client.strategic else "flagged",
        },
        reasoning=f"{f.measured} over {f.months} months ({shown}). Proposed fix: {f.proposed_fix}.",
        policy_ref="pol-022" if b.client.strategic else "pol-020",
        confidence=min(1.0, max(0.0, f.score)), required_role=Role.CONTROLLER,
    )


class CreditAnalyst(Agent):
    """Scores clients (value, reliability, coverage), flags exploits, proposes tier changes."""

    name = "credit-analyst"

    async def run(self) -> list[Proposal]:
        books = load_books(self.db)
        work = self.db.sql("SELECT * FROM work_item")
        precedents = self.db.sql("SELECT * FROM precedent")
        cleared = {f["id"] for f in self.db.sql("SELECT * FROM exploit_flag")
                   if f["status"] == "cleared"}
        p = plan(books, work, precedents, cleared, use_claude=True)
        for row in p.profiles:
            self.db.upsert_credit_profile(**row)
        for row in p.flag_rows:
            self.db.upsert_exploit_flag(**row)
        for work_item_id in p.withdraw:
            self.db.decide(work_item_id, "WITHDRAWN", "superseded by a newer credit review")
        return p.proposals
