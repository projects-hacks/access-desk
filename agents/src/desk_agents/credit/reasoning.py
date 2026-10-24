"""
The plain-English paragraph on a proposal the rules decided. When Claude
decides (decide.py), its own reasons are the paragraph; this template is the
fallback and uses only numbers the engine computed.
"""

from .model import Flag, Scores, TierDecision


def template(decision: TierDecision, scores: Scores, flags: list[Flag]) -> str:
    b = scores.breakdown
    head = {
        "tier_change": f"Proposes tier {decision.current} -> {decision.to_tier}.",
        "review": f"Asks a controller to review this strategic client's tier {decision.current}.",
        "stay": f"Keeps tier {decision.current}.",
    }[decision.action]
    parts = [
        head,
        (
            f"Reliability {scores.reliability:.1f} (lateness -{b['lateness']:.1f}, "
            f"frequency -{b['frequency']:.1f}, severity -{b['severity']:.0f}, "
            f"paid in pieces -{b['pieces']:.1f}, disputes lost -{b['disputes']:.1f}, "
            f"over {b['periods']:.0f} months); value {scores.value:.1f}."
        ),
        _sentence("; ".join(decision.reasons)),
    ]
    for f in flags:
        if f.fired:
            ids = ", ".join(e.invoice_id for e in f.evidence[:6])
            more = f" and {len(f.evidence) - 6} more" if len(f.evidence) > 6 else ""
            parts.append(f"{f.pattern}: {f.measured} ({ids}{more}).")
    parts.append(f"Coverage {scores.coverage_ratio:.2f}x: {scores.coverage_detail}")
    if scores.expected_settle_on:
        parts.append(f"Expected to settle by {scores.expected_settle_on.isoformat()}.")
    return " ".join(parts)


def _sentence(text: str) -> str:
    return text[:1].upper() + text[1:] + "."
