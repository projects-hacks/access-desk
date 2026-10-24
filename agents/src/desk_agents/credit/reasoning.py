"""
The plain-English paragraph on each proposal. Claude only rewords numbers the
engine already computed; with no key, or on any error, a template says the same.
"""

import json
import logging

import anthropic

from ..config import settings
from .model import Flag, Scores, TierDecision

log = logging.getLogger("desk_agents.credit")

TIMEOUT_SECONDS = 20.0
MAX_WORDS = 120

PROMPT = """You write the reasoning paragraph on a credit-tier proposal a controller will \
approve or reject. Use only the facts in the JSON below. Cite invoice ids from the evidence. \
Do not introduce any number that is not in the JSON. At most {words} words, plain prose, \
no headings or lists.

{facts}"""


def facts(decision: TierDecision, scores: Scores, flags: list[Flag]) -> dict:
    fired = [f for f in flags if f.fired]
    return {
        "decision": decision.model_dump(mode="json"),
        "reliability": round(scores.reliability, 1),
        "value": round(scores.value, 1),
        "coverage_ratio": round(scores.coverage_ratio, 2),
        "coverage_detail": scores.coverage_detail,
        "expected_settle_on": scores.expected_settle_on.isoformat()
        if scores.expected_settle_on else None,
        "breakdown": {k: round(v, 2) for k, v in scores.breakdown.items()},
        "flags": [
            {"pattern": f.pattern, "measured": f.measured,
             "evidence_invoice_ids": [e.invoice_id for e in f.evidence]}
            for f in fired
        ],
    }


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


def explain(decision: TierDecision, scores: Scores, flags: list[Flag],
            use_claude: bool = True) -> str:
    fallback = template(decision, scores, flags)
    if not use_claude or not settings.anthropic_api_key:
        return fallback
    try:
        client = anthropic.Anthropic(
            api_key=settings.anthropic_api_key, timeout=TIMEOUT_SECONDS, max_retries=0,
        )
        response = client.messages.create(
            model=settings.anthropic_model,
            max_tokens=2000,
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": PROMPT.format(
                words=MAX_WORDS, facts=json.dumps(facts(decision, scores, flags), indent=1),
            )}],
        )
        if response.stop_reason != "end_turn":
            return fallback
        text = " ".join(b.text for b in response.content if b.type == "text").strip()
        return text or fallback
    except Exception:
        log.exception("reasoning fell back to the template for %s", decision.client_id)
        return fallback
