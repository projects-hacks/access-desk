"""
Six exploit detectors, one per pattern planted in the history. Each returns
its measured number even when it doesn't fire, so the reasoning can say why a
client was cleared.
"""

from collections import Counter, defaultdict
from collections.abc import Callable
from datetime import timedelta
from statistics import mean, median

from .model import ClientBook, Evidence, Flag, Invoice
from .scoring import scored_invoices


def restriction_day(book: ClientBook) -> int:
    """Days after due when access may first be restricted: grace, the notice day, then cure."""
    return book.contract.grace_days + 1 + book.contract.cure_days


def _paid(book: ClientBook) -> list[Invoice]:
    return sorted(
        (i for i in book.invoices if i.status == "paid" and i.paid_on),
        key=lambda i: (i.period, i.id),
    )


def _lag(i: Invoice) -> int:
    assert i.paid_on
    return (i.paid_on - i.due_on).days


def _ev(i: Invoice, note: str) -> Evidence:
    lag = _lag(i) if i.paid_on else 0
    return Evidence(invoice_id=i.id, due_on=i.due_on, paid_on=i.paid_on, dpd=max(0, lag), note=note)


def _flag(pattern: str, fired: bool, measured: str, evidence: list[Evidence], score: float,
          fix: str, months: int) -> Flag:
    """Evidence is kept only for a fired flag; the measured string always explains the result."""
    return Flag(
        pattern=pattern, fired=fired, measured=measured, evidence=evidence if fired else [],
        months=months, score=round(score, 3), proposed_fix=fix,
    )


def restriction_eve(book: ClientBook) -> Flag:
    """Single payments in the last 8 periods land on the same day after due, past grace."""
    periods = sorted({s.invoice.period for s in scored_invoices(book)})[-8:]
    single = [i for i in _paid(book) if i.period in periods and len(i.payments) == 1]
    lags = Counter(_lag(i) for i in single)
    day, hits = lags.most_common(1)[0] if lags else (0, 0)
    share = hits / len(single) if single else 0.0
    grace = book.contract.grace_days
    fired = len(single) >= 6 and share >= 0.85 and day > grace
    matching = [i for i in single if _lag(i) == day]
    return _flag(
        "restriction_eve", fired,
        f"{hits} of {len(single)} single-payment invoices paid on day {day} "
        f"(grace {grace}, restriction day {restriction_day(book)})",
        [_ev(i, f"paid on day {day}") for i in matching], share,
        "Auto Pay or prepay on the due date; shorter cure at renewal",
        months=len({i.period for i in matching}),
    )


def partial_reset(book: ClientBook) -> Flag:
    """A small first payment, then the balance after the restriction day."""
    limit = restriction_day(book)
    split = [i for i in book.invoices if len(i.payments) >= 2]
    hits = []
    for i in split:
        first, last = i.payments[0], i.payments[-1]
        if first.amount_cents < 0.6 * i.amount_cents and (last.value_on - i.due_on).days > limit:
            hits.append((i, (first.value_on - i.due_on).days, (last.value_on - i.due_on).days))
    return _flag(
        "partial_reset", len(hits) >= 2,
        f"{len(hits)} invoices paid in pieces with the balance after restriction day {limit}",
        [Evidence(invoice_id=i.id, due_on=i.due_on, paid_on=i.paid_on, dpd=last,
                  note=f"first payment day {first}, balance day {last} vs restriction day {limit}")
         for i, first, last in hits],
        len(hits) / len(split) if split else 0.0,
        "Clause: a partial payment reduces the balance but doesn't stop the cure clock",
        months=len({i.period for i, _, _ in hits}),
    )


def pays_restricted_only(book: ClientBook) -> Flag:
    """One product paid fast, another paid late: the median lag differs by 15+ days."""
    by_product: dict[str, list[Invoice]] = defaultdict(list)
    for i in _paid(book):
        by_product[i.product].append(i)
    medians = {p: median(_lag(i) for i in lst) for p, lst in by_product.items()}
    grace = book.contract.grace_days
    if len(medians) < 2:
        return _flag("pays_restricted_only", False, "one product paid", [], 0.0, "", months=0)
    ranked = sorted(medians, key=lambda p: (medians[p], p))
    fast, slow = ranked[0], ranked[-1]
    gap = medians[slow] - medians[fast]
    fired = gap >= 15 and medians[slow] > grace
    slow_late = [i for i in by_product[slow] if _lag(i) > grace]
    return _flag(
        "pays_restricted_only", fired,
        f"median lag {fast} day {medians[fast]:g}, {slow} day {medians[slow]:g} (grace {grace})",
        [_ev(i, f"{slow} paid on day {_lag(i)}; {fast} on day {medians[fast]:g}")
         for i in slow_late],
        len(slow_late) / len(by_product[slow]),
        "Cross-default at renewal, so a late custody bill puts API in default too",
        months=len({i.period for i in slow_late}),
    )


# The plan said 5; Halcyon's normal Feb 28 wire for January makes 6 (owner approved 6).
QUARTER_END_MAX_DATES = 6


def quarter_end(book: ClientBook) -> Flag:
    """Few payment dates in the last year, each covering 2+ months of invoices."""
    start = book.today - timedelta(days=365)
    dates: dict = defaultdict(set)
    paid_by: dict = defaultdict(list)
    for i in book.invoices:
        for p in i.payments:
            if start <= p.value_on <= book.today:
                dates[p.value_on].add(i.period)
                paid_by[p.value_on].append(i)
    periods = {period for ps in dates.values() for period in ps}
    ratio = len(periods) / len(dates) if dates else 0.0
    fired = 1 <= len(dates) <= QUARTER_END_MAX_DATES and ratio >= 2
    return _flag(
        "quarter_end", fired,
        f"{len(dates)} payment dates for {len(periods)} months of invoices in 12 months",
        [_ev(i, f"paid {d.isoformat()} with {len(dates[d])} months of invoices")
         for d in sorted(dates) for i in paid_by[d]],
        min(1.0, ratio / 3), "Strategic: controller review only, no automatic fix",
        months=len(periods),
    )


def recent_late(book: ClientBook) -> Flag:
    """The last 3 paid months got worse than before: a trend, not a one-off."""
    worst: dict[str, tuple[int, Invoice]] = {}
    for i in _paid(book):
        dpd = max(0, _lag(i))
        if i.period not in worst or dpd > worst[i.period][0]:
            worst[i.period] = (dpd, i)
    ordered = [worst[p] for p in sorted(worst)]
    last3, prior = ordered[-3:], ordered[:-3]
    late = [x for x in last3 if x[0] > 5]
    jump = (mean(d for d, _ in last3) - mean(d for d, _ in prior)) if last3 and prior else 0.0
    fired = len(last3) == 3 and len(late) >= 2 and jump >= 7
    renewal = book.client.renewal_on
    return _flag(
        "recent_late", fired,
        f"last 3 months {', '.join(str(d) for d, _ in last3)} days late vs "
        f"{mean(d for d, _ in prior) if prior else 0:.1f} before (+{jump:.1f})",
        [_ev(i, f"{i.period} paid {d} days late") for d, i in last3],
        len(late) / 3,
        "No upgrade; recheck at renewal" + (f" on {renewal.isoformat()}" if renewal else ""),
        months=len(last3),
    )


def dispute_delay(book: ClientBook) -> Flag:
    """Most months disputed, disputes upheld, then paid within days of each ruling."""
    scored_periods = {s.invoice.period for s in scored_invoices(book)}
    by_id = {i.id: i for i in book.invoices}
    # A dispute still under review takes its month out of scoring, so it isn't counted here either.
    disputed_periods = {
        by_id[d.invoice_id].period for d in book.disputes if d.invoice_id in by_id
    } & scored_periods
    resolved = [d for d in book.disputes if d.status == "resolved"]
    upheld = [d for d in resolved if d.resolution == "no_change"]
    prompt = [
        d for d in resolved
        if d.resolved_on and (i := by_id.get(d.invoice_id)) and i.paid_on
        and 0 <= (i.paid_on - d.resolved_on).days <= 3
    ]
    month_share = len(disputed_periods) / len(scored_periods) if scored_periods else 0.0
    upheld_share = len(upheld) / len(resolved) if resolved else 0.0
    prompt_share = len(prompt) / len(resolved) if resolved else 0.0
    fired = month_share >= 0.5 and upheld_share >= 0.8 and prompt_share >= 0.8
    return _flag(
        "dispute_delay", fired,
        f"{len(disputed_periods)} of {len(scored_periods)} months disputed, "
        f"{len(upheld)} of {len(resolved)} upheld, {len(prompt)} paid within 3 days of the ruling",
        [_ev(by_id[d.invoice_id], f"disputed {d.opened_on}, upheld {d.resolved_on}")
         for d in prompt],
        min(month_share, upheld_share, prompt_share),
        "Escalate; disputes filed after a default notice don't stop the cure period",
        months=len(disputed_periods),
    )


DETECTORS: list[Callable[[ClientBook], Flag]] = [
    restriction_eve, partial_reset, pays_restricted_only, quarter_end, recent_late, dispute_delay,
]


def detect(book: ClientBook) -> list[Flag]:
    """Every detector's result, fired or not."""
    return [d(book) for d in DETECTORS]
