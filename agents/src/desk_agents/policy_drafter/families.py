from dataclasses import dataclass
from typing import Any

from .harness.run_tests import decided_actions, parse_actions

Row = dict[str, Any]


@dataclass(frozen=True)
class Family:
    """Policies whose precedents are drafted together, and the policy a draft for them becomes."""

    name: str
    policy_refs: tuple[str, ...]
    draft_policy_id: str
    base_policy_id: str


# pol-003 is the historical restriction ladder (precedents only); pol-006 is the one the access
# controller cites today. Overrides of either feed the same draft.
FAMILIES = (
    Family(name="restriction_ladder", policy_refs=("pol-003", "pol-006"), draft_policy_id="pol-014",
           base_policy_id="pol-006"),
)

# Decisions that close a proposal without a person overriding it.
NOT_OVERRIDES = {"Approved", "Withdrawn", ""}


def family_of(policy_ref: str) -> Family | None:
    return next((f for f in FAMILIES if policy_ref in f.policy_refs), None)


def is_override(p: Row) -> bool:
    """A person decided something other than what was proposed, on a restriction we can read."""
    decision = (p.get("decision") or "").strip()
    if decision in NOT_OVERRIDES or parse_actions(p.get("proposed", "")) is None:
        return False
    if decision == "Rejected":
        return True
    return decision.casefold() != p["proposed"].strip().casefold() and decided_actions(p) is not None


def is_control(p: Row) -> bool:
    """A decision that confirmed the proposed restriction: the draft must leave it unchanged."""
    decision = (p.get("decision") or "").strip()
    return (decision == "Approved" or decision.casefold() == (p.get("proposed") or "").strip().casefold()) \
        and parse_actions(p.get("proposed", "")) is not None


def group(precedents: list[Row]) -> dict[str, dict[str, list[Row]]]:
    """Per family: its overrides and its confirmed decisions, oldest first."""
    out = {f.name: {"overrides": [], "controls": []} for f in FAMILIES}
    for p in sorted(precedents, key=lambda p: (p["decided_on"], p["id"])):
        family = family_of(p.get("policy_ref", ""))
        if family is None:
            continue
        if is_override(p):
            out[family.name]["overrides"].append(p)
        elif is_control(p):
            out[family.name]["controls"].append(p)
    return out
