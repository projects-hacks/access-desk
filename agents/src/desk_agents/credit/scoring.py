"""
Reliability, value, coverage and the expected settle date. Pure functions over
ClientBooks; every score keeps its breakdown so the reasoning can quote it.
"""

import math
from dataclasses import dataclass
from datetime import date, timedelta

from .model import ClientBook, Invoice, Scores

HALF_LIFE_DAYS = 90
NEUTRAL = 70
PRIOR_PERIODS = 3
PRODUCTS = 4


@dataclass(frozen=True)
class Scored:
    """An invoice past its due date that counts toward reliability."""

    invoice: Invoice
    paid: bool
    lag: int
    age: int
    weight: float

    @property
    def dpd(self) -> int:
        return max(0, self.lag)


def scored_invoices(book: ClientBook) -> list[Scored]:
    """Past due, not void, not under an open dispute. Paid: lag to paid_on; open: lag to today."""
    disputed = book.open_dispute_invoice_ids()
    out = []
    for inv in book.invoices:
        if inv.due_on >= book.today or inv.status == "void" or inv.id in disputed:
            continue
        paid = inv.status == "paid" and inv.paid_on is not None
        end = inv.paid_on if paid and inv.paid_on else book.today
        age = (book.today - inv.due_on).days
        out.append(Scored(inv, paid, (end - inv.due_on).days, age, 0.5 ** (age / HALF_LIFE_DAYS)))
    return sorted(out, key=lambda s: (s.invoice.due_on, s.invoice.id))


def reliability(book: ClientBook) -> tuple[float, dict[str, float]]:
    rows = scored_invoices(book)
    total = sum(s.weight for s in rows)
    mean_dpd = sum(s.weight * s.dpd for s in rows) / total if total else 0.0
    late_share = sum(s.weight for s in rows if s.dpd > 10) / total if total else 0.0
    worst = max((s.dpd for s in rows if s.age <= 180), default=0)
    pieces_weight = sum(s.weight for s in rows if len(s.invoice.payments) >= 2)
    lost = sum(1 for d in book.disputes if d.status == "resolved" and d.resolution == "no_change")

    lateness = min(35.0, 0.8 * mean_dpd)
    frequency = 20.0 * late_share
    severity = 15.0 if worst > 60 else 8.0 if worst > 30 else 0.0
    pieces = min(10.0, 4.0 * pieces_weight)
    disputes = min(15.0, 1.5 * lost)
    raw = max(0.0, 100.0 - (lateness + frequency + severity + pieces + disputes))
    m = len({s.invoice.period for s in rows})
    score = (m * raw + PRIOR_PERIODS * NEUTRAL) / (m + PRIOR_PERIODS)
    return score, {
        "weighted_mean_dpd": mean_dpd,
        "late_share": late_share,
        "worst_dpd_180d": worst,
        "lateness": lateness,
        "frequency": frequency,
        "severity": severity,
        "pieces": pieces,
        "disputes": disputes,
        "disputes_lost": lost,
        "raw": raw,
        "periods": m,
    }


def trailing_billing(book: ClientBook) -> tuple[int, int]:
    """Cents billed and distinct products on invoices issued in the 365 days before today."""
    start = book.today - timedelta(days=365)
    recent = [i for i in book.invoices if start <= i.issued_on <= book.today]
    return sum(i.amount_cents for i in recent), len({i.product for i in recent})


def values(books: list[ClientBook]) -> dict[str, tuple[float, dict[str, float]]]:
    """Log of fees billed, scaled from the smallest client (0) to the largest (1), plus product breadth."""
    billed = {b.client.id: trailing_billing(b) for b in books}
    logs = {cid: math.log(t12) for cid, (t12, _) in billed.items() if t12 > 0}
    lo, hi = min(logs.values(), default=0.0), max(logs.values(), default=0.0)
    out = {}
    for cid, (t12, products) in billed.items():
        scale = (logs[cid] - lo) / (hi - lo) if cid in logs and hi > lo else 0.0
        size, breadth = 75.0 * scale, 25.0 * products / PRODUCTS
        out[cid] = (size + breadth, {
            "billed_12m_cents": t12, "products": products, "size": size, "breadth": breadth,
        })
    return out


def exposure_cents(book: ClientBook) -> int:
    disputed = book.open_dispute_invoice_ids()
    return sum(
        i.amount_cents - i.paid_cents
        for i in book.invoices
        if i.status not in ("paid", "void", "disputed") and i.id not in disputed
    )


def coverage(book: ClientBook) -> tuple[float, str, int]:
    """(Debitable USD custody + owed to client) / undisputed unpaid amount."""
    exposure = exposure_cents(book)
    debit = book.clause("debit")
    set_off = book.clause("set_off")
    usd = sum(h.value_cents for h in book.custody if h.asset == "USD")
    debitable = usd if debit and debit.allowed else 0
    liquid = debitable + book.owed_to_client_cents
    ratio = liquid / exposure if exposure else 0.0

    holdable = sum(h.value_cents for h in book.custody) if set_off and set_off.allowed else 0
    debit_part = (
        f"Debitable {_usd(debitable)} under §{debit.clause}" if debit and debit.allowed
        else "no §6.3 debit clause"
    )
    multiple = f"{holdable / exposure:.1f}x exposure" if exposure else "no exposure"
    hold_part = (
        f"holdable custody {_usd(holdable)} under §{set_off.clause} = {multiple}"
        if set_off and set_off.allowed else "no §7.2 set-off clause"
    )
    detail = f"{debit_part}; {hold_part}; owed to client {_usd(book.owed_to_client_cents)}."
    return ratio, detail, exposure


def weighted_median(pairs: list[tuple[int, float]]) -> int | None:
    if not pairs:
        return None
    pairs = sorted(pairs)
    half = sum(w for _, w in pairs) / 2
    running = 0.0
    for value, w in pairs:
        running += w
        if running >= half:
            return value
    return pairs[-1][0]


def expected_settle_on(book: ClientBook) -> tuple[date | None, int | None]:
    """Due date of the oldest open undisputed invoice + the recency-weighted median lag."""
    lag = weighted_median([(s.lag, s.weight) for s in scored_invoices(book) if s.paid])
    disputed = book.open_dispute_invoice_ids()
    open_ = [
        i for i in book.invoices
        if i.status not in ("paid", "void", "disputed") and i.id not in disputed
    ]
    if not open_:
        return None, lag
    oldest = min(open_, key=lambda i: (i.due_on, i.id))
    settle = oldest.due_on + timedelta(days=lag or 0)
    return max(settle, book.today), lag


def score_all(books: list[ClientBook]) -> dict[str, Scores]:
    value_of = values(books)
    out = {}
    for b in books:
        rel, rel_parts = reliability(b)
        val, val_parts = value_of[b.client.id]
        ratio, detail, exposure = coverage(b)
        settle, lag = expected_settle_on(b)
        out[b.client.id] = Scores(
            client_id=b.client.id,
            reliability=rel,
            value=val,
            coverage_ratio=ratio,
            coverage_detail=detail,
            exposure_cents=exposure,
            expected_settle_on=settle,
            breakdown={**rel_parts, **val_parts, "median_lag": float(lag or 0)},
        )
    return out


def _usd(cents: int) -> str:
    return f"${cents / 100:,.0f}"
