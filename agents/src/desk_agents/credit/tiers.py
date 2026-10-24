"""
Formula tier on the platform's 1-5 scale (1 best), then the guardrails in
order: strategic clients only get a review, upgrades go one step and need a
3-point margin and no recent_late flag, downgrades go at most two steps.
"""

from .model import ClientBook, Flag, Scores, TierDecision

# (lowest reliability in the band, base tier). Below the last line: tier 5.
BANDS = [(85.0, 2), (70.0, 3), (55.0, 4)]
LINES = [line for line, _ in BANDS]
VALUE_BUMP = 75.0
TIER1_RELIABILITY = 85.0
FLAG_CAP = 3
UPGRADE_MARGIN = 3.0
MAX_DOWNGRADE_STEPS = 2
NEAR_LINE = 5.0

POLICY = {"downgrade": "pol-020", "upgrade": "pol-021", "review": "pol-022"}


def base_band(reliability: float) -> tuple[int, float]:
    """(base tier, the band's lower line) from reliability alone."""
    for line, tier in BANDS:
        if reliability >= line:
            return tier, line
    return 5, 0.0


def formula_tier(scores: Scores, flags: list[Flag]) -> tuple[int, list[str]]:
    rel = scores.reliability
    tier, line = base_band(rel)
    reasons = [f"reliability {rel:.1f} puts the base at tier {tier} (band from {line:g})"]
    if scores.value >= VALUE_BUMP and tier > 1:
        bumped = tier - 1
        if bumped == 1 and rel < TIER1_RELIABILITY:
            reasons.append(f"value {scores.value:.1f} would lift it, but tier 1 needs "
                           f"reliability {TIER1_RELIABILITY:g}")
        else:
            tier = bumped
            reasons.append(f"value {scores.value:.1f} >= {VALUE_BUMP:g} lifts it to tier {tier}")
    fired = [f.pattern for f in flags if f.fired]
    if fired and tier < FLAG_CAP:
        tier = FLAG_CAP
        reasons.append(f"{', '.join(fired)} caps it at tier {FLAG_CAP}")
    return tier, reasons


def decide(book: ClientBook, scores: Scores, flags: list[Flag]) -> TierDecision:
    current = book.client.tier
    formula, reasons = formula_tier(scores, flags)
    near = any(abs(scores.reliability - line) <= NEAR_LINE for line in LINES)

    def result(action: str, to: int, policy: str, why: str) -> TierDecision:
        return TierDecision(
            client_id=book.client.id, current=current, formula=formula, action=action,
            to_tier=to, confidence=0.7 if near else 0.9, policy_ref=policy,
            reasons=[*reasons, why],
        )

    if formula == current:
        return result("stay", current, "", f"formula tier {formula} matches the current tier")
    if book.client.strategic:
        if formula > current:
            return result("review", current, POLICY["review"],
                          f"strategic: formula says tier {formula}, so a person reviews the tier")
        return result("stay", current, "", "strategic: tiers change only by a person")
    if formula < current:
        if any(f.fired and f.pattern == "recent_late" for f in flags):
            return result("stay", current, "", "upgrade blocked: recent_late fired")
        _, line = base_band(scores.reliability)
        if scores.reliability < line + UPGRADE_MARGIN:
            return result("stay", current, "",
                          f"upgrade blocked: reliability {scores.reliability:.1f} is within "
                          f"{UPGRADE_MARGIN:g} points of the {line:g} band line")
        return result("tier_change", current - 1, POLICY["upgrade"],
                      f"upgrade one step from tier {current} to {current - 1}")
    to = current + min(MAX_DOWNGRADE_STEPS, formula - current)
    return result("tier_change", to, POLICY["downgrade"],
                  f"downgrade from tier {current} to {to} (formula {formula}, at most "
                  f"{MAX_DOWNGRADE_STEPS} steps)")
