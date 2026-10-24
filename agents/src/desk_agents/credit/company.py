"""
Company-specific policies (`pol-020:ORG-90677`, versioned) and their
deterministic evaluator. A controller activates a version; from its
`effective_on` the evaluator measures the success criteria on the invoices due
since. A failing policy is fed back into the next decision for that company:
that is the learning loop.
"""

import json
from datetime import date, timedelta
from statistics import mean
from typing import Any, Literal

from pydantic import BaseModel

from .detectors import DETECTORS
from .guardrails import Criterion, PolicyChoice
from .model import ClientBook, Invoice

MIN_INVOICES = 2  # fewer invoices due since the policy took effect: no verdict yet


class CompanyPolicy(BaseModel):
    key: str
    policy_id: str
    version: int
    status: str
    title: str
    client_id: str
    rule: dict[str, Any]
    effective_on: date | None
    work_item_id: int | None

    @property
    def criteria(self) -> list[Criterion]:
        return [Criterion.model_validate(c) for c in self.rule.get("success_criteria", [])]


class CriterionResult(BaseModel):
    metric: str
    target: float
    pattern: str | None
    measured: float | None
    invoices: int
    passed: bool | None
    text: str


class Evaluation(BaseModel):
    policy_key: str
    client_id: str
    status: Literal["pending", "passing", "failing"]
    results: list[CriterionResult]

    def outcome(self, today: date) -> str:
        detail = "; ".join(r.text for r in self.results)
        return f"{self.status} on {today.isoformat()}: {detail}"


def client_of(policy_id: str) -> str | None:
    _, _, owner = policy_id.partition(":")
    return owner or None


def parse_policies(rows: list[dict[str, Any]]) -> list[CompanyPolicy]:
    """Company-specific policy rows (policy_id `<base>:<client>`); malformed rows are skipped."""
    out = []
    for r in rows:
        owner = client_of(r["policy_id"])
        if not owner:
            continue
        try:
            rule = json.loads(r["rule_json"] or "{}")
            eff = rule.get("effective_on")
            out.append(CompanyPolicy(
                key=r["key"], policy_id=r["policy_id"], version=int(r["version"]),
                status=r["status"], title=r["title"], client_id=owner, rule=rule,
                effective_on=date.fromisoformat(eff) if eff else None,
                work_item_id=int(rule["work_item_id"]) if rule.get("work_item_id") else None,
            ))
        except (ValueError, KeyError, TypeError):
            continue
    return sorted(out, key=lambda p: (p.policy_id, p.version))


def next_version(rows: list[dict[str, Any]], policy_id: str) -> int:
    """A draft that never reached a controller is overwritten; otherwise one past the latest."""
    mine = [r for r in rows if r["policy_id"] == policy_id]
    if not mine:
        return 1
    latest = max(mine, key=lambda r: int(r["version"]))
    return int(latest["version"]) + (0 if latest["status"] == "draft" else 1)


def company_policy_id(choice: PolicyChoice, client_id: str) -> str:
    base = choice.policy_id.partition(":")[0]
    return f"{base}:{client_id}"


def rule_json(choice: PolicyChoice, client_id: str, proposed_on: date) -> dict[str, Any]:
    return {
        "client_id": client_id,
        "base": choice.policy_id.partition(":")[0],
        "terms": [t.model_dump() for t in choice.terms],
        "success_criteria": [k.model_dump() for k in choice.success_criteria],
        "proposed_on": proposed_on.isoformat(),
    }


def _lag(i: Invoice, today: date) -> int:
    return ((i.paid_on or today) - i.due_on).days


def evaluate(book: ClientBook, policy: CompanyPolicy) -> Evaluation:
    """Pure: the policy's criteria on invoices due since it took effect (grace elapsed)."""
    grace = book.contract.grace_days
    results = []
    for k in policy.criteria:
        if policy.effective_on is None:
            results.append(_result(k, None, 0, "not active yet"))
            continue
        end = policy.effective_on + timedelta(days=round(k.window_months * 30.44))
        window = [
            i for i in book.invoices
            if policy.effective_on <= i.due_on <= end and i.status != "void"
            and (i.paid_on is not None or i.due_on + timedelta(days=grace) < book.today)
        ]
        results.append(_measure(book, k, window, grace))
    statuses = {r.passed for r in results}
    status = ("failing" if False in statuses else "pending" if None in statuses or not results
              else "passing")
    return Evaluation(policy_key=policy.key, client_id=policy.client_id, status=status,
                      results=results)


def _measure(book: ClientBook, k: Criterion, window: list[Invoice], grace: int) -> CriterionResult:
    n = len(window)
    if n < MIN_INVOICES:
        return _result(k, None, n, f"{k.metric}: {n} invoices due since, too few to judge")
    lags = [max(0, _lag(i, book.today)) for i in window]
    if k.metric == "share_paid_within_grace":
        on_time = sum(1 for i in window if i.paid_on and _lag(i, book.today) <= grace)
        share = on_time / n
        return _result(k, share, n, f"{on_time} of {n} paid within {grace} days "
                       f"({share:.2f} vs >= {k.target:g})", share >= k.target)
    if k.metric == "mean_days_late":
        m = mean(lags)
        return _result(k, m, n, f"mean {m:.1f} days late over {n} invoices (<= {k.target:g})",
                       m <= k.target)
    if k.metric == "max_days_late":
        worst = max(lags)
        return _result(k, worst, n, f"worst {worst} days late over {n} invoices "
                       f"(<= {k.target:g})", worst <= k.target)
    detector = next((d for d in DETECTORS if d.__name__ == k.pattern), None)
    if detector is None:
        return _result(k, None, n, f"unknown pattern {k.pattern}")
    ids = {i.id for i in window}
    since = book.model_copy(update={"invoices": window, "disputes": [
        d for d in book.disputes if d.invoice_id in ids]})
    flag = detector(since)
    return _result(k, 1.0 if flag.fired else 0.0, n,
                   f"{k.pattern} {'still fires' if flag.fired else 'does not fire'} on {n} "
                   f"invoices since ({flag.measured})", not flag.fired)


def _result(k: Criterion, measured: float | None, n: int, text: str,
            passed: bool | None = None) -> CriterionResult:
    return CriterionResult(metric=k.metric, target=k.target, pattern=k.pattern,
                           measured=None if measured is None else round(measured, 3),
                           invoices=n, passed=passed, text=text)
