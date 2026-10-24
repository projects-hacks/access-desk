"""
Hard limits on any credit decision, whoever made it. Claude proposes; these
checks (pure, deterministic) decide whether the proposal may reach a
controller at all. The deterministic tier formula is evidence, not a limit:
the only limits are the ones below.

`GUARDRAILS` is the machine-readable list that goes into the prompt;
`violations()` checks a candidate against it.
"""

from typing import Literal

from pydantic import BaseModel

from .model import ClientBook, Flag, Scores, TierDecision

MIN_TIER, MAX_TIER = 1, 5
MAX_STEPS_DOWN = 2
MAX_STEPS_UP = 1
FLAG_TIER_CAP = 3
GRACE_BOUNDS = (0, 15)
CURE_BOUNDS = (5, 15)
REMINDER_BOUNDS = (1, 10)
WINDOW_BOUNDS = (1, 12)
MAX_DAYS_TARGET = 90
BASE_POLICIES = ("pol-020", "pol-021", "pol-022")

Lever = Literal["prepay", "custody_debit", "cross_default", "grace_days", "cure_days", "reminder"]
Metric = Literal["share_paid_within_grace", "mean_days_late", "max_days_late", "pattern_not_firing"]
PATTERNS = (
    "restriction_eve", "partial_reset", "pays_restricted_only", "quarter_end", "recent_late",
    "dispute_delay",
)


# ── What Claude returns (every field required: structured output schema) ─────


class Term(BaseModel):
    """One lever. `value` is days for grace_days / cure_days / reminder, else null."""

    lever: Lever
    value: int | None
    at_renewal: bool


class Criterion(BaseModel):
    """
    A deterministic success test over invoices due after the policy takes effect.
    share_paid_within_grace: share (0-1) paid within the grace days, passes when >= target.
    mean_days_late / max_days_late: days, passes when <= target.
    pattern_not_firing: `pattern` does not fire on the post-policy invoices (target ignored).
    """

    metric: Metric
    target: float
    pattern: str | None
    window_months: int


class PolicyChoice(BaseModel):
    """
    `existing`: cite an active policy by id (baseline or this company's own).
    `company_draft`: a new company-specific version of `policy_id` (a base id such as
    pol-020, or this company's `pol-020:<client_id>`), drafted for a controller.
    """

    kind: Literal["existing", "company_draft"]
    policy_id: str
    title: str
    terms: list[Term]
    success_criteria: list[Criterion]


class Decision(BaseModel):
    action: Literal["stay", "tier_change", "review"]
    to_tier: int
    policy: PolicyChoice | None
    reasons: list[str]
    cited_invoice_ids: list[str]
    confidence: float


# ── The rules, as the prompt sees them ──────────────────────────────────────

GUARDRAILS: list[dict[str, str]] = [
    {"id": "tier_range", "rule": f"to_tier is an integer {MIN_TIER}..{MAX_TIER} (1 best)."},
    {"id": "action_shape", "rule": "stay and review keep to_tier = current tier; tier_change "
     "moves it."},
    {"id": "max_down", "rule": f"At most {MAX_STEPS_DOWN} steps worse per proposal."},
    {"id": "max_up", "rule": f"At most {MAX_STEPS_UP} step better per proposal."},
    {"id": "strategic", "rule": "Strategic client: never tier_change; use review (pol-022)."},
    {"id": "recent_late", "rule": "No upgrade while recent_late is fired."},
    {"id": "flag_cap", "rule": f"Any fired flag: a tier_change may not go better than tier "
     f"{FLAG_TIER_CAP}."},
    {"id": "lever_prepay", "rule": "prepay only if the contract has an allowed `prepay` clause."},
    {"id": "lever_debit", "rule": "custody_debit only if the contract has an allowed `debit` "
     "clause."},
    {"id": "lever_cross_default", "rule": "cross_default only as a renewal term "
     "(at_renewal true), and only if the contract doesn't already have it."},
    {"id": "lever_grace", "rule": f"grace_days only as a renewal term, value "
     f"{GRACE_BOUNDS[0]}..{GRACE_BOUNDS[1]}."},
    {"id": "lever_cure", "rule": f"cure_days only as a renewal term, value "
     f"{CURE_BOUNDS[0]}..{CURE_BOUNDS[1]}."},
    {"id": "lever_reminder", "rule": f"reminder: days before due, value "
     f"{REMINDER_BOUNDS[0]}..{REMINDER_BOUNDS[1]}; may apply now."},
    {"id": "lever_value", "rule": "value is null for prepay, custody_debit, cross_default."},
    {"id": "policy_exists", "rule": "existing: policy_id must be one of the active policies "
     "listed."},
    {"id": "draft_shape", "rule": f"company_draft: policy_id is a base id {', '.join(BASE_POLICIES)}"
     " or <base>:<client_id> for this client; a title, 1+ terms and 1+ success criteria."},
    {"id": "one_open_draft", "rule": "No company_draft while one for this client waits on a "
     "controller."},
    {"id": "criteria", "rule": f"share target 0..1; days targets 0..{MAX_DAYS_TARGET}; "
     f"pattern_not_firing names a known pattern; window_months {WINDOW_BOUNDS[0]}.."
     f"{WINDOW_BOUNDS[1]}."},
    {"id": "citations", "rule": "Every cited invoice id appears in the facts; a tier_change or "
     "company_draft cites at least one."},
    {"id": "confidence", "rule": "confidence is 0..1."},
    {"id": "reasons", "rule": "At least one reason."},
]


def fired(flags: list[Flag]) -> list[str]:
    return [f.pattern for f in flags if f.fired]


def applicable(book: ClientBook, flags: list[Flag]) -> list[str]:
    """The client-specific guardrails, in words (shown to Claude and to the controller)."""
    c, out = book.client, []
    if c.strategic:
        out.append("strategic: review only, no tier change")
    patterns = fired(flags)
    if patterns:
        out.append(f"flag cap: {', '.join(patterns)} fired, tier no better than {FLAG_TIER_CAP}")
    if "recent_late" in patterns:
        out.append("no upgrade: recent_late fired")
    lo = max(MIN_TIER, c.tier - MAX_STEPS_UP)
    hi = min(MAX_TIER, c.tier + MAX_STEPS_DOWN)
    out.append(f"tier from {c.tier}: {lo}..{hi}")
    prepay, debit = _allowed(book, "prepay"), _allowed(book, "debit")
    out.append(f"prepay {'allowed' if prepay else 'not in contract'}; custody debit "
               f"{'allowed' if debit else 'not allowed'}")
    out.append("cross-default " + ("already signed" if book.contract.cross_default
                                   else "only at renewal"))
    out.append("grace/cure changes only at renewal"
               + (f" ({c.renewal_on.isoformat()})" if c.renewal_on else ""))
    return out


def _allowed(book: ClientBook, kind: str) -> bool:
    clause = book.clause(kind)
    return bool(clause and clause.allowed)


def violations(
    book: ClientBook,
    scores: Scores,
    flags: list[Flag],
    baseline: TierDecision,
    candidate: Decision,
    evidence_ids: set[str],
    active_policy_ids: set[str],
    open_draft: bool = False,
) -> list[str]:
    """Every rule the candidate breaks, as `<guardrail id>: <why>`. Empty means allowed."""
    del scores, baseline  # evidence only; the limits don't depend on them
    c, d, out = book.client, candidate, []
    current = c.tier

    if not MIN_TIER <= d.to_tier <= MAX_TIER:
        out.append(f"tier_range: to_tier {d.to_tier} is outside {MIN_TIER}..{MAX_TIER}")
    if d.action in ("stay", "review") and d.to_tier != current:
        out.append(f"action_shape: {d.action} must keep tier {current}, not {d.to_tier}")
    if d.action == "tier_change":
        if d.to_tier == current:
            out.append(f"action_shape: tier_change to the current tier {current}")
        if d.to_tier - current > MAX_STEPS_DOWN:
            out.append(f"max_down: {d.to_tier - current} steps down from {current} to "
                       f"{d.to_tier}; at most {MAX_STEPS_DOWN}")
        if current - d.to_tier > MAX_STEPS_UP:
            out.append(f"max_up: {current - d.to_tier} steps up from {current} to {d.to_tier}; "
                       f"at most {MAX_STEPS_UP}")
        if c.strategic:
            out.append(f"strategic: {c.name} is strategic; propose a review, not a tier change")
        patterns = fired(flags)
        if d.to_tier < current and "recent_late" in patterns:
            out.append("recent_late: no upgrade while recent_late is fired")
        if patterns and d.to_tier < FLAG_TIER_CAP:
            out.append(f"flag_cap: {', '.join(patterns)} fired; tier {d.to_tier} is better than "
                       f"{FLAG_TIER_CAP}")

    if d.policy:
        out += _policy_violations(book, d.policy, active_policy_ids, open_draft)

    unknown = [i for i in d.cited_invoice_ids if i not in evidence_ids]
    if unknown:
        out.append(f"citations: not in the facts: {', '.join(unknown)}")
    drafting = d.policy is not None and d.policy.kind == "company_draft"
    if (d.action == "tier_change" or drafting) and not d.cited_invoice_ids:
        out.append("citations: a tier change or company policy must cite at least one invoice")
    if not 0.0 <= d.confidence <= 1.0:
        out.append(f"confidence: {d.confidence} is outside 0..1")
    if not any(r.strip() for r in d.reasons):
        out.append("reasons: give at least one reason")
    return out


def _policy_violations(book: ClientBook, p: PolicyChoice, active: set[str],
                       open_draft: bool) -> list[str]:
    cid, out = book.client.id, []
    if p.kind == "existing":
        if p.policy_id not in active:
            out.append(f"policy_exists: {p.policy_id} is not an active policy")
        if p.terms or p.success_criteria:
            out.append("policy_exists: an existing policy carries no new terms or criteria; "
                       "use company_draft")
        return out

    base, _, owner = p.policy_id.partition(":")
    if base not in BASE_POLICIES or (owner and owner != cid):
        out.append(f"draft_shape: {p.policy_id} must be one of {', '.join(BASE_POLICIES)} or "
                   f"<base>:{cid}")
    if not p.title.strip():
        out.append("draft_shape: a company policy needs a title")
    if not p.terms:
        out.append("draft_shape: a company policy needs at least one term")
    if not p.success_criteria:
        out.append("draft_shape: a company policy needs at least one success criterion")
    if open_draft:
        out.append(f"one_open_draft: a policy draft for {cid} already waits on a controller")
    for t in p.terms:
        out += _term_violations(book, t)
    for k in p.success_criteria:
        out += _criterion_violations(k)
    return out


def _term_violations(book: ClientBook, t: Term) -> list[str]:
    out = []
    needs_value = t.lever in ("grace_days", "cure_days", "reminder")
    if needs_value and t.value is None:
        out.append(f"lever_value: {t.lever} needs a value in days")
    if not needs_value and t.value is not None:
        out.append(f"lever_value: {t.lever} takes no value")
    if t.lever == "prepay" and not _allowed(book, "prepay"):
        out.append("lever_prepay: the contract has no allowed prepay clause")
    if t.lever == "custody_debit" and not _allowed(book, "debit"):
        out.append("lever_debit: the contract doesn't allow custody debits")
    if t.lever == "cross_default":
        if not t.at_renewal:
            out.append("lever_cross_default: cross-default only as a renewal term")
        if book.contract.cross_default:
            out.append("lever_cross_default: the contract already has cross-default")
    for lever, (lo, hi), gid in (("grace_days", GRACE_BOUNDS, "lever_grace"),
                                 ("cure_days", CURE_BOUNDS, "lever_cure"),
                                 ("reminder", REMINDER_BOUNDS, "lever_reminder")):
        if t.lever != lever:
            continue
        if lever != "reminder" and not t.at_renewal:
            out.append(f"{gid}: {lever} changes only as a renewal term")
        if t.value is not None and not lo <= t.value <= hi:
            out.append(f"{gid}: {lever} {t.value} is outside {lo}..{hi}")
    return out


def _criterion_violations(k: Criterion) -> list[str]:
    out = []
    if k.metric == "share_paid_within_grace" and not 0.0 <= k.target <= 1.0:
        out.append(f"criteria: share target {k.target} is outside 0..1")
    if k.metric in ("mean_days_late", "max_days_late") and not 0 <= k.target <= MAX_DAYS_TARGET:
        out.append(f"criteria: {k.metric} target {k.target} is outside 0..{MAX_DAYS_TARGET}")
    if k.metric == "pattern_not_firing" and k.pattern not in PATTERNS:
        out.append(f"criteria: unknown pattern {k.pattern}")
    if not WINDOW_BOUNDS[0] <= k.window_months <= WINDOW_BOUNDS[1]:
        out.append(f"criteria: window_months {k.window_months} is outside "
                   f"{WINDOW_BOUNDS[0]}..{WINDOW_BOUNDS[1]}")
    return out


def from_baseline(d: TierDecision) -> Decision:
    """The deterministic decision in Claude's shape (cites the policy it used, no new terms)."""
    return Decision(
        action=d.action, to_tier=d.to_tier,
        policy=PolicyChoice(kind="existing", policy_id=d.policy_ref, title="", terms=[],
                            success_criteria=[]) if d.policy_ref else None,
        reasons=d.reasons, cited_invoice_ids=[], confidence=d.confidence,
    )
