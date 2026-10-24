"""
How accurate is the engine? Replays the books as they stood at past month-ends
(load.cut drops everything dated later) and compares what the engine said then
with what the clients actually did afterwards. Pure: no network, no Claude.

- Settle dates: predicted date for each client's oldest open invoice vs the day
  it was actually paid, against a naive "pays on the due date" baseline.
- Tier calls: a downgrade holds up if the client then paid an invoice > 10 days
  late within 90 days; an upgrade holds up if it didn't.
- Exploits: which detectors fired at each cutoff, against the planted answer key.
"""

from datetime import date, timedelta
from statistics import mean, median
from typing import Any

from .detectors import detect
from .load import cut
from .model import ClientBook
from .scoring import score_all
from .tiers import decide

HORIZON_DAYS = 90
LATE_DPD = 10
PLANTED = {
    "quarter_end:ORG-90101", "recent_late:ORG-90412", "dispute_delay:ORG-90518",
    "restriction_eve:ORG-90677", "partial_reset:ORG-90744", "pays_restricted_only:ORG-90758",
}
# Real behaviour the data also shows; a correct detector may flag it.
ALSO_REAL = {"recent_late:ORG-90229"}


def month_ends(start: date, end: date) -> list[date]:
    out, d = [], date(start.year, start.month, 1)
    while True:
        nxt = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
        last = nxt - timedelta(days=1)
        if last > end:
            return out
        if last >= start:
            out.append(last)
        d = nxt


def _oldest_open(book: ClientBook):
    disputed = book.open_dispute_invoice_ids()
    open_ = [i for i in book.invoices
             if i.status not in ("paid", "void", "disputed") and i.id not in disputed]
    return min(open_, key=lambda i: (i.due_on, i.id)) if open_ else None


def backtest(books: list[ClientBook], cutoffs: list[date],
             tier_then: dict[str, int] | None = None) -> dict[str, Any]:
    """`tier_then`: each client's tier before today's approvals (live data); default book tier."""
    today = books[0].today
    tier_then = tier_then or {}
    final = {b.client.id: {i.id: i for i in b.invoices} for b in books}
    settle_rows, tier_rows, flag_rows, calib_rows = [], [], [], []
    for t in cutoffs:
        past = [cut(b, t) for b in books]
        past = [b.model_copy(update={"client": b.client.model_copy(update={
            "tier": tier_then.get(b.client.id, b.client.tier)})}) for b in past]
        scores = score_all(past)
        for b in past:
            cid = b.client.id
            s = scores[cid]
            flags = detect(b)
            for f in flags:
                if f.fired:
                    flag_rows.append({"cutoff": t.isoformat(), "flag": f"{f.pattern}:{cid}",
                                      "name": b.client.name})
            # Settle date for the oldest open invoice, scored once it is actually paid.
            inv = _oldest_open(b)
            if inv and s.expected_settle_on:
                actual = final[cid].get(inv.id)
                if actual and actual.paid_on and actual.status == "paid":
                    settle_rows.append({
                        "cutoff": t.isoformat(), "client": b.client.name, "invoice": inv.id,
                        "predicted": s.expected_settle_on.isoformat(),
                        "actual": actual.paid_on.isoformat(),
                        "error_days": (actual.paid_on - s.expected_settle_on).days,
                        "naive_error_days": (actual.paid_on - max(inv.due_on, t)).days,
                    })
            # Tier calls, judged on the invoices that fell due in the next 90 days.
            d = decide(b, s, flags)
            if (today - t).days < 30:
                continue
            window = [i for i in final[cid].values()
                      if t < i.due_on <= min(t + timedelta(days=HORIZON_DAYS), today)]
            if not window:
                continue
            late = [i for i in window
                    if ((i.paid_on if i.status == "paid" and i.paid_on else today) - i.due_on).days
                    > LATE_DPD]
            calib_rows.append({"formula": d.formula, "late": len(late), "due": len(window)})
            if d.action != "tier_change":
                continue
            down = d.to_tier > d.current
            tier_rows.append({
                "cutoff": t.isoformat(), "client": b.client.name,
                "call": f"{d.current} -> {d.to_tier}", "kind": "downgrade" if down else "upgrade",
                "late_after": len(late), "due_after": len(window),
                "held": bool(late) if down else not late,
            })

    errors = [abs(r["error_days"]) for r in settle_rows]
    naive = [abs(r["naive_error_days"]) for r in settle_rows]
    final_flags = {r["flag"] for r in flag_rows if r["cutoff"] == cutoffs[-1].isoformat()}
    ever = {r["flag"] for r in flag_rows}
    calibration = {}
    for tier in range(1, 6):
        rows = [r for r in calib_rows if r["formula"] == tier]
        due = sum(r["due"] for r in rows)
        if due:
            calibration[str(tier)] = {"invoices": due,
                                      "late_share": round(sum(r["late"] for r in rows) / due, 3)}
    first_seen: dict[str, str] = {}
    for r in flag_rows:
        first_seen.setdefault(r["flag"], r["cutoff"])
    return {
        "today": today.isoformat(),
        "cutoffs": [c.isoformat() for c in cutoffs],
        "settle": {
            "n": len(settle_rows),
            "mae_days": round(mean(errors), 1) if errors else None,
            "median_abs_days": median(errors) if errors else None,
            "within_3_days": round(sum(e <= 3 for e in errors) / len(errors), 3) if errors else None,
            "within_7_days": round(sum(e <= 7 for e in errors) / len(errors), 3) if errors else None,
            "bias_days": round(mean(r["error_days"] for r in settle_rows), 1) if errors else None,
            "naive_mae_days": round(mean(naive), 1) if naive else None,
            "rows": settle_rows,
        },
        "tiers": {
            "n": len(tier_rows),
            "held": sum(r["held"] for r in tier_rows),
            **{f"{k}s": {"n": sum(r["kind"] == k for r in tier_rows),
                         "held": sum(r["held"] for r in tier_rows if r["kind"] == k)}
               for k in ("upgrade", "downgrade")},
            "rows": tier_rows,
            "calibration": calibration,
        },
        "exploits": {
            "planted": sorted(PLANTED),
            "caught": sorted(PLANTED & final_flags),
            "missed": sorted(PLANTED - final_flags),
            "false_alarms": sorted(final_flags - PLANTED - ALSO_REAL),
            "false_alarms_any_cutoff": sorted(ever - PLANTED - ALSO_REAL),
            "also_real": sorted(final_flags & ALSO_REAL),
            "first_seen": dict(sorted(first_seen.items())),
        },
    }


def render(r: dict[str, Any]) -> str:
    s, t, e = r["settle"], r["tiers"], r["exploits"]
    lines = [
        (f"Backtest at {len(r['cutoffs'])} month-ends ({r['cutoffs'][0]} .. {r['cutoffs'][-1]}),"
        f" outcomes known to {r['today']}"),
        "",
        f"Settle-date prediction ({s['n']} predictions later paid)",
        (f"  mean error {s['mae_days']} days (median {s['median_abs_days']}), bias {s['bias_days']:+}"
        f" days; within 3 days {s['within_3_days']:.0%}, within 7 days {s['within_7_days']:.0%}"),
        f"  naive 'pays on the due date' baseline: mean error {s['naive_mae_days']} days",
        "",
        (f"Calibration: share of invoices > {LATE_DPD} days late in the {HORIZON_DAYS} days after,"
        " by the tier the formula gave"),
        *[f"  tier {k}: {v['late_share']:.0%} late ({v['invoices']} invoices)"
          for k, v in t["calibration"].items()],
        "",
        (f"Tier calls ({t['n']} judged on the 90 days after): {t['held']} held up"
        f" (downgrades {t['downgrades']['held']} of {t['downgrades']['n']},"
        f" upgrades {t['upgrades']['held']} of {t['upgrades']['n']})"),
    ]
    for row in t["rows"]:
        lines.append(f"  {row['cutoff']} {row['client']:24} {row['call']:7} {row['kind']:9} "
                     f"{'held' if row['held'] else 'did NOT hold'} "
                     f"({row['late_after']} of {row['due_after']} invoices > {LATE_DPD} days late)")
    lines += [
        "",
        (f"Exploits: caught {len(e['caught'])} of {len(e['planted'])} planted, "
        f"{len(e['false_alarms'])} false alarms, also real: {', '.join(e['also_real']) or '-'}"),
    ]
    for flag, when in e["first_seen"].items():
        lines.append(f"  {flag:38} first fired at {when}")
    if e["missed"]:
        lines.append(f"  missed: {', '.join(e['missed'])}")
    if e["false_alarms_any_cutoff"]:
        lines.append(f"  fired at some earlier month-end without being planted: "
                     f"{', '.join(e['false_alarms_any_cutoff'])}")
    return "\n".join(lines)
