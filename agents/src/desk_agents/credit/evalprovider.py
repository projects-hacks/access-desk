"""
The gate for a decision provider (Claude API, Factory Droid, ...). Runs the same backtest the
owner approved and scores five things against fixed pass marks. Live calls happen only through
the `ask` you pass in; this module never imports a provider itself.
"""

import json
import math
import time
from collections.abc import Callable
from datetime import date
from statistics import median
from typing import Any

from .backtest import backtest_claude
from .decide import Ask, Reply
from .model import ClientBook

MIN_VALID_SHARE = 0.95
RIGHT_NUM, RIGHT_DEN = 12, 17  # 12 of the 17 differences; scaled when the total differs
MIN_REPEAT_SHARE = 0.90
MAX_CYCLE_SECONDS = 90.0
REPEATS = 3
MIN_DAYS_AFTER = 30  # a cutoff needs this long afterwards to be judged (as in the backtest)
DEFAULT_PRICES = {"input": 4.0, "output": 20.0}  # claude-opus-5-5, USD per million tokens


def _timed(ask: Ask, seconds: list[float]) -> Ask:
    def wrapped(messages: list[dict[str, Any]]) -> Reply:
        t0 = time.monotonic()
        try:
            return ask(messages)
        finally:
            seconds.append(time.monotonic() - t0)
    return wrapped


def _asked(outcomes: list[tuple[str, Any]]) -> list[tuple[str, Any]]:
    """Outcomes where the provider was actually called (a quiet company is never asked)."""
    return [x for x in outcomes if x[1].attempts]


def cost_usd(usage: list[Any], prices: dict[str, float] | None) -> float | None:
    if not prices or "input" not in prices or "output" not in prices:
        return None
    tin = sum(getattr(u, "input_tokens", 0) or 0 for u in usage)
    tout = sum(getattr(u, "output_tokens", 0) or 0 for u in usage)
    return round((tin * prices["input"] + tout * prices["output"]) / 1_000_000, 4)


def _check(name: str, value: str, mark: str, ok: bool | None) -> dict[str, Any]:
    return {"check": name, "value": value, "mark": mark,
            "status": "INFO" if ok is None else "PASS" if ok else "FAIL"}


def evaluate_provider(
    books: list[ClientBook], cutoffs: list[date], ask: Ask, *,
    tier_then: dict[str, int] | None = None, usage: list[Any] | None = None,
    prices: dict[str, float] | None = None, provider: str = "provider",
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    usage = usage if usage is not None else []
    seconds: list[float] = []
    timed = _timed(ask, seconds)

    # (a) valid answers and (b) right-when-differs: the full backtest
    outs: list[tuple[str, Any]] = []
    bt = backtest_claude(books, cutoffs, timed, tier_then, outcomes_out=outs)
    asked = _asked(outs)
    accepted = sum(o.decided_by == "claude" for _, o in asked)
    valid_share = accepted / len(asked) if asked else 0.0

    # (c) repeatability and (d) cycle time: the latest judged cutoff, decided REPEATS times
    today = books[0].today
    eligible = [c for c in cutoffs if (today - c).days >= MIN_DAYS_AFTER]
    runs: list[dict[str, tuple[str, int]]] = []
    cycle = 0.0
    for i in range(REPEATS if eligible else 0):
        once: list[tuple[str, Any]] = []
        t0 = clock()
        backtest_claude(books, [eligible[-1]], timed, tier_then, outcomes_out=once)
        if i == 0:
            cycle = clock() - t0
        runs.append({o.client_id: (o.final.action, o.final.to_tier) for _, o in _asked(once)})
    ids = sorted(set.intersection(*(set(r) for r in runs))) if runs else []
    same = sum(len({r[c] for r in runs}) == 1 for c in ids)
    repeat_share = same / len(ids) if ids else 0.0

    n_diff, right = bt["disagree"], bt["claude_right_when_disagree"]
    need = math.ceil(n_diff * RIGHT_NUM / RIGHT_DEN)
    cost = cost_usd(usage, prices)

    checks = [
        _check("valid within two tries", f"{accepted}/{len(asked)} = {valid_share:.0%}",
               f">= {MIN_VALID_SHARE:.0%}", bool(asked) and valid_share >= MIN_VALID_SHARE),
        _check("right when it differs from the rules", f"{right} of {n_diff}",
               f">= {need} of {n_diff} (12 of 17)", n_diff > 0 and right >= need),
        _check("repeatability (3 runs, same cutoff)", f"{same}/{len(ids)} = {repeat_share:.0%}",
               f">= {MIN_REPEAT_SHARE:.0%}", bool(ids) and repeat_share >= MIN_REPEAT_SHARE),
        _check("full cycle", f"{cycle:.1f} s", f"<= {MAX_CYCLE_SECONDS:.0f} s",
               bool(runs) and cycle <= MAX_CYCLE_SECONDS),
        _check("cost (all calls)", "unknown" if cost is None else f"${cost:.2f}", "reported only",
               None),
    ]
    return {
        "provider": provider,
        "cutoffs": [c.isoformat() for c in cutoffs],
        "repeat_cutoff": eligible[-1].isoformat() if eligible else None,
        "calls": len(seconds),
        "asked": len(asked), "accepted": accepted,
        "decisions": bt["decisions"], "agree": bt["agree"], "disagree": n_diff,
        "right_when_differs": right, "rules_right_when_differs": bt["rules_right_when_disagree"],
        "repeat_clients": len(ids), "repeat_identical": same,
        "latency": {"median_s": round(median(seconds), 2) if seconds else None,
                    "max_s": round(max(seconds), 2) if seconds else None,
                    "cycle_s": round(cycle, 2)},
        "tokens": {"input": sum(getattr(u, "input_tokens", 0) or 0 for u in usage),
                   "output": sum(getattr(u, "output_tokens", 0) or 0 for u in usage)},
        "cost_usd": cost,
        "checks": checks,
        "passed": all(c["status"] != "FAIL" for c in checks),
    }


def render(r: dict[str, Any]) -> str:
    lat = r["latency"]
    lines = [
        (f"Provider gate: {r['provider']}  ({len(r['cutoffs'])} month-ends, "
         f"repeat cutoff {r['repeat_cutoff']})"),
        (f"  per-call seconds: median {lat['median_s']}, max {lat['max_s']}; "
         f"{r['calls']} calls, tokens in {r['tokens']['input']} / out {r['tokens']['output']}"),
        "",
        f"{'check':42} {'result':18} {'pass mark':22} status",
    ]
    lines += [f"{c['check']:42} {c['value']:18} {c['mark']:22} {c['status']}" for c in r["checks"]]
    lines += ["", "GATE: " + ("PASS" if r["passed"] else "FAIL")]
    return "\n".join(lines)


def write_json(r: dict[str, Any], path: str) -> None:
    with open(path, "w") as f:
        json.dump(r, f, indent=1)
