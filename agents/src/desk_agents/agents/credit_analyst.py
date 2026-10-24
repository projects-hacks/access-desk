import json
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from ..credit.company import (
    CompanyPolicy,
    Evaluation,
    company_policy_id,
    evaluate,
    next_version,
    parse_policies,
    rule_json,
)
from ..credit.decide import (
    BASE_CREDIT_POLICIES,
    Ask,
    CompanyContext,
    Outcome,
    Request,
    claude_ask,
    decide_all,
)
from ..credit.detectors import detect
from ..credit.load import load_books
from ..credit.model import ClientBook, Evidence, Flag, Scores, TierDecision
from ..credit.reasoning import template
from ..credit.scoring import score_all
from ..credit.tiers import decide
from ..models import Proposal, Role, WorkItemKind
from .base import Agent

OPEN_STATES = {"PROPOSED", "NEEDS_INFO", "APPROVED", "POSTED"}
REJECTION_MEMORY_DAYS = 30
KINDS = ("CREDIT_REVIEW", "POLICY_DRAFT")


@dataclass
class Plan:
    """Everything one run writes: profiles every time, policies and proposals only when new."""

    scores: dict[str, Scores]
    flags: dict[str, list[Flag]]
    decisions: dict[str, TierDecision]
    outcomes: dict[str, Outcome] = field(default_factory=dict)
    evaluations: dict[str, list[Evaluation]] = field(default_factory=dict)
    profiles: list[dict[str, Any]] = field(default_factory=list)
    policy_rows: list[dict[str, Any]] = field(default_factory=list)
    policy_outcomes: list[tuple[str, str]] = field(default_factory=list)
    proposals: list[Proposal] = field(default_factory=list)
    withdraw: list[int] = field(default_factory=list)


def subject_of(d: TierDecision) -> str | None:
    if d.action == "tier_change":
        return f"tier:{d.client_id}:{d.current}->{d.to_tier}"
    if d.action == "review":
        return f"review:{d.client_id}"
    return None


def view_of(d: TierDecision) -> str:
    """The rules' view of a client; a new view lets the client be decided again."""
    return subject_of(d) or f"stay:{d.client_id}"


def flags_from_table(book: ClientBook, rows: list[dict[str, Any]]) -> list[Flag]:
    """ExploitWatch's rows for this client as flags; `cleared` rows don't count."""
    invoices = {i.id: i for i in book.invoices}
    out = []
    for r in sorted(rows, key=lambda r: r["id"]):
        if r["status"] == "cleared":
            continue
        try:
            raw = json.loads(r.get("evidence_json") or "[]")
        except ValueError:
            raw = []
        evidence = []
        for e in raw if isinstance(raw, list) else []:
            inv = invoices.get(e.get("invoice_id", "")) if isinstance(e, dict) else None
            if inv is None:
                continue
            paid = inv.paid_on
            evidence.append(Evidence(
                invoice_id=inv.id, due_on=inv.due_on, paid_on=paid,
                dpd=int(e.get("dpd", max(0, ((paid or book.today) - inv.due_on).days))),
                note=str(e.get("note", "")),
            ))
        out.append(Flag(
            pattern=r["pattern"], fired=True,
            measured=r.get("measured") or f"flagged by ExploitWatch ({r['status']}, "
            f"{r['months']} months, score {float(r['score']):.2f})",
            evidence=evidence, months=int(r["months"]), score=float(r["score"]),
            proposed_fix=r.get("proposed_fix", ""),
        ))
    return out


def plan(
    books: list[ClientBook],
    work_items: list[dict[str, Any]],
    precedents: list[dict[str, Any]],
    flag_rows: list[dict[str, Any]] | None = None,
    policy_rows: list[dict[str, Any]] | None = None,
    ask: Ask | None = None,
    memo: dict[str, tuple[str, Outcome]] | None = None,
) -> Plan:
    """
    Pure apart from `ask`: score, read flags, decide (Claude within the guardrails, or the
    rules), and pick what isn't already open or recently rejected.
    """
    if not books:
        return Plan({}, {}, {})
    today = books[0].today
    flag_rows = flag_rows or []
    policy_rows = policy_rows or []
    scores = score_all(books)
    flags = {}
    for b in books:
        rows = [r for r in flag_rows if r["client_id"] == b.client.id]
        flags[b.client.id] = flags_from_table(b, rows) if rows else detect(b)
    baselines = {b.client.id: decide(b, scores[b.client.id], flags[b.client.id]) for b in books}
    company = parse_policies(policy_rows)

    ours = [w for w in work_items if w["kind"] in KINDS]
    rejected_on = {
        int(p["work_item_id"]): date.fromisoformat(p["decided_on"])
        for p in precedents
        if p.get("source") == "live" and p.get("decision") == "Rejected"
        and p.get("work_item_id") is not None
    }
    withdraw: list[int] = []
    held: set[str] = set()
    open_draft: set[str] = set()
    evaluated: dict[str, list[Evaluation]] = {}
    requests = []
    for b in books:
        cid, base = b.client.id, baselines[b.client.id]
        view = view_of(base)
        mine = [w for w in ours if w["client_id"] == cid]
        for w in mine:
            seen = _view(w)
            if w["state"] in OPEN_STATES:
                stale = (w["kind"] == "CREDIT_REVIEW" and w["state"] in ("PROPOSED", "NEEDS_INFO")
                         and seen != view)
                if stale:  # a newer view of the same client supersedes its open review
                    withdraw.append(int(w["id"]))
                elif seen == view:
                    held.add(cid)
                if w["kind"] == "POLICY_DRAFT" and not stale:
                    open_draft.add(cid)
            elif (w["state"] == "REJECTED" and seen == view
                  and rejected_on.get(int(w["id"]), date.min)
                  > today - timedelta(days=REJECTION_MEMORY_DAYS)):
                held.add(cid)

        mine_policies = [p for p in company if p.client_id == cid]
        evaluations = [evaluate(b, p) for p in mine_policies if p.status == "active"]
        ctx = CompanyContext(
            policies=_credit_policies(policy_rows),
            active_policy_ids=_active_ids(policy_rows, cid),
            company_policies=mine_policies, evaluations=evaluations,
            precedents=[_precedent(p) for p in precedents
                        if p.get("client_id") == cid and p.get("source") == "live"],
            open_draft=cid in open_draft,
        )
        evaluated[cid] = evaluations
        if cid not in held:
            requests.append(Request(b, scores[cid], flags[cid], base, ctx))

    outcomes = decide_all(requests, ask, memo)
    out = Plan(scores, flags, {cid: o.final for cid, o in outcomes.items()}, outcomes, evaluated)
    for cid in held:  # waiting on a controller: the rules' view stands in, nothing new
        out.decisions[cid] = baselines[cid]
    out.withdraw = withdraw
    withdrawn = set(withdraw)
    open_subjects = {w["subject_id"] for w in ours
                     if w["state"] in OPEN_STATES and int(w["id"]) not in withdrawn}

    for b in books:
        cid, s = b.client.id, scores[b.client.id]
        out.profiles.append({
            "client_id": cid,
            "value_score": _score(s.value),
            "reliability_score": _score(s.reliability),
            "coverage_ratio": round(s.coverage_ratio, 4),
            "coverage_detail": s.coverage_detail,
            "expected_settle_on": s.expected_settle_on.isoformat() if s.expected_settle_on
            else None,
        })
        out.policy_outcomes += [(e.policy_key, e.outcome(today)) for e in evaluated[cid]
                                if e.status != "pending"]

        o = outcomes.get(cid)
        if o is None:
            continue
        subject = subject_of(o.final)
        if subject and subject not in open_subjects:
            out.proposals.append(_review_proposal(b, s, flags[cid], o, subject))
        if o.draft and cid not in open_draft:
            row, proposal = _policy_draft(b, s, o, policy_rows, today)
            out.policy_rows.append(row)
            out.proposals.append(proposal)
    return out


def _view(w: dict[str, Any]) -> str:
    try:
        recorded = json.loads(w.get("proposal_json") or "{}").get("view")
    except ValueError:
        recorded = None
    return recorded or w["subject_id"]


def _credit_policies(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    base = [r for r in rows if r["policy_id"] in BASE_CREDIT_POLICIES]
    return [{"id": r["policy_id"], "version": r["version"], "status": r["status"],
             "title": r["title"], "rule": _json(r["rule_json"])}
            for r in sorted(base, key=lambda r: r["key"])]


def _active_ids(rows: list[dict[str, Any]], cid: str) -> list[str]:
    if not rows:
        return list(BASE_CREDIT_POLICIES)
    return sorted({r["policy_id"] for r in rows if r["status"] == "active" and (
        r["policy_id"] in BASE_CREDIT_POLICIES or r["policy_id"].endswith(f":{cid}"))})


def _precedent(p: dict[str, Any]) -> dict[str, Any]:
    keys = ("decided_on", "situation", "proposed", "decision", "override_reason", "outcome",
            "policy_ref")
    return {k: p.get(k, "") for k in keys}


def _json(raw: str) -> Any:
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return raw


def _score(x: float) -> int:
    return max(0, min(100, round(x)))


def _decision_meta(o: Outcome) -> dict[str, Any]:
    b = o.baseline
    return {
        "decided_by": o.decided_by,
        "why": o.why,
        "view": view_of(b),
        "baseline": {"action": b.action, "to_tier": b.to_tier, "policy_ref": b.policy_ref,
                     "confidence": b.confidence, "reasons": b.reasons},
        "choice": o.choice.model_dump() if o.choice else None,
        "guardrails": o.guardrails,
        "rejected_attempts": [a.model_dump() for a in o.attempts
                              if a.violations or a.error],
    }


def _reasoning(b: ClientBook, s: Scores, fl: list[Flag], o: Outcome) -> str:
    if o.decided_by == "rules" or o.choice is None:
        return template(o.final, s, fl)
    d, base = o.choice, o.baseline
    cited = ", ".join(d.cited_invoice_ids[:10]) + (
        f" and {len(d.cited_invoice_ids) - 10} more" if len(d.cited_invoice_ids) > 10 else "")
    rules = {"tier_change": f"tier {base.current} -> {base.to_tier}",
             "review": "a review", "stay": f"keep tier {base.current}"}[base.action]
    parts = [" ".join(d.reasons)]
    if cited:
        parts.append(f"Evidence: {cited}.")
    parts.append(f"The rules alone would {'propose ' if base.action != 'stay' else ''}{rules}.")
    return " ".join(parts)


def _review_proposal(b: ClientBook, s: Scores, fl: list[Flag], o: Outcome,
                     subject: str) -> Proposal:
    d = o.final
    title = (
        f"{b.client.name}: tier {d.current} → {d.to_tier}" if d.action == "tier_change"
        else f"{b.client.name}: review strategic tier" if b.client.strategic
        else f"{b.client.name}: review tier"
    )
    return Proposal(
        kind=WorkItemKind.CREDIT_REVIEW, client_id=b.client.id, subject_id=subject, title=title,
        amount_cents=s.exposure_cents, proposal={**d.proposal(s, fl), **_decision_meta(o)},
        reasoning=_reasoning(b, s, fl, o), policy_ref=d.policy_ref,
        confidence=d.confidence, required_role=Role.CONTROLLER,
    )


def _policy_draft(b: ClientBook, s: Scores, o: Outcome, rows: list[dict[str, Any]],
                  today: date) -> tuple[dict[str, Any], Proposal]:
    assert o.draft and o.choice
    cid, p, d = b.client.id, o.draft, o.choice
    policy_id = company_policy_id(p, cid)
    version = next_version(rows, policy_id)
    rule = rule_json(p, cid, today)
    learned = f"{'; '.join(d.reasons)} Evidence: {', '.join(d.cited_invoice_ids)}."
    row = {"policy_id": policy_id, "version": version, "status": "draft", "title": p.title,
           "rule_json": json.dumps(rule), "learned_from": learned}
    key = f"{policy_id}@{version}"
    terms = "; ".join(_term_text(t.lever, t.value, t.at_renewal) for t in p.terms)
    proposal = Proposal(
        kind=WorkItemKind.POLICY_DRAFT, client_id=cid, subject_id=f"policy:{key}",
        title=f"{b.client.name}: {p.title}", amount_cents=s.exposure_cents,
        proposal={"policy_key": key, "policy_id": policy_id, "version": version,
                  "title": p.title, "rule": rule, **_decision_meta(o)},
        reasoning=f"{learned} Terms: {terms}. Success: "
        + "; ".join(_criterion_text(k.metric, k.target, k.pattern, k.window_months)
                    for k in p.success_criteria) + ".",
        policy_ref=policy_id, confidence=d.confidence, required_role=Role.CONTROLLER,
    )
    return row, proposal


def _term_text(lever: str, value: int | None, at_renewal: bool) -> str:
    v = f" {value} days" if value is not None else ""
    return f"{lever.replace('_', ' ')}{v}{' at renewal' if at_renewal else ''}"


def _criterion_text(metric: str, target: float, pattern: str | None, months: int) -> str:
    if metric == "pattern_not_firing":
        return f"{pattern} stops firing within {months} months"
    op = ">=" if metric == "share_paid_within_grace" else "<="
    return f"{metric.replace('_', ' ')} {op} {target:g} over {months} months"


class CreditAnalyst(Agent):
    """Scores clients, lets Claude decide tiers and terms within guardrails, drafts policies."""

    name = "credit-analyst"

    def __init__(self, db, ask: Ask | None = None):
        super().__init__(db)
        self.ask = ask if ask is not None else claude_ask()
        self.memo: dict[str, tuple[str, Outcome]] = {}

    async def run(self) -> list[Proposal]:
        books = load_books(self.db)
        work = self.db.sql("SELECT * FROM work_item")
        precedents = self.db.sql("SELECT * FROM precedent")
        flags = self.db.sql("SELECT * FROM exploit_flag")
        policies = self.db.sql("SELECT * FROM policy")
        p = plan(books, work, precedents, flags, policies, ask=self.ask, memo=self.memo)
        for row in p.profiles:
            self.db.upsert_credit_profile(**row)
        for row in p.policy_rows:
            self.db.upsert_policy(**row)
        for key, outcome in p.policy_outcomes:
            self.db.record_policy_outcome(key, outcome)
        for work_item_id in p.withdraw:
            self.db.decide(work_item_id, "WITHDRAWN", "superseded by a newer credit review")
        return p.proposals


__all__ = ["CompanyPolicy", "CreditAnalyst", "Plan", "plan"]
