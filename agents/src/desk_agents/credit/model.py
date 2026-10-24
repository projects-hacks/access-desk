"""Typed inputs (one ClientBook per client) and outputs of the credit engine."""

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel


class Client(BaseModel):
    id: str
    name: str
    segment: str
    tier: int
    strategic: bool
    renewal_on: date | None = None


class Contract(BaseModel):
    terms_days: int
    grace_days: int
    cure_days: int
    cross_default: bool


class Clause(BaseModel):
    clause: str
    kind: str
    allowed: bool


class Payment(BaseModel):
    value_on: date
    amount_cents: int


class Invoice(BaseModel):
    id: str
    product: str
    period: str
    issued_on: date
    due_on: date
    amount_cents: int
    paid_cents: int
    paid_on: date | None = None
    status: str
    payments: list[Payment] = []


class Dispute(BaseModel):
    id: str
    invoice_id: str
    opened_on: date
    resolved_on: date | None = None
    resolution: str = ""
    status: str


class Holding(BaseModel):
    asset: str
    value_cents: int


class ClientBook(BaseModel):
    """Everything the engine may know about one client on `today` (nothing dated later)."""

    client: Client
    contract: Contract
    clauses: list[Clause] = []
    invoices: list[Invoice] = []
    disputes: list[Dispute] = []
    custody: list[Holding] = []
    owed_to_client_cents: int = 0
    today: date

    def clause(self, kind: str) -> Clause | None:
        return next((c for c in self.clauses if c.kind == kind), None)

    def open_dispute_invoice_ids(self) -> set[str]:
        ids = {d.invoice_id for d in self.disputes if d.status == "under_review"}
        return ids | {i.id for i in self.invoices if i.status == "disputed"}


class Scores(BaseModel):
    client_id: str
    reliability: float
    value: float
    coverage_ratio: float
    coverage_detail: str
    exposure_cents: int
    expected_settle_on: date | None
    breakdown: dict[str, float]


class Evidence(BaseModel):
    invoice_id: str
    due_on: date
    paid_on: date | None
    dpd: int
    note: str


class Flag(BaseModel):
    pattern: str
    fired: bool
    measured: str
    evidence: list[Evidence]
    months: int
    score: float
    proposed_fix: str


class TierDecision(BaseModel):
    client_id: str
    current: int
    formula: int
    action: Literal["stay", "tier_change", "review"]
    to_tier: int
    confidence: float
    policy_ref: str
    reasons: list[str]

    def proposal(self, scores: Scores, flags: list[Flag]) -> dict[str, Any]:
        return {
            "action": self.action,
            "from_tier": self.current,
            "to_tier": self.to_tier,
            "reliability": round(scores.reliability, 1),
            "value": round(scores.value, 1),
            "coverage_ratio": round(scores.coverage_ratio, 2),
            "breakdown": {k: round(v, 2) for k, v in scores.breakdown.items()},
            "flags": [f.pattern for f in flags if f.fired],
            "expected_settle_on": scores.expected_settle_on.isoformat()
            if scores.expected_settle_on
            else None,
        }
