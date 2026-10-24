"""
Checks a drafted policy rule against one test case per precedent.

Run from the workspace root:  python harness/run_tests.py

Workspace
  data/        read-only snapshot: task.json, precedents.json, clients.json, contracts.json,
               invoices.json, payments.json, positions.json, levers.json, capability.json, policies.json
  harness/     read-only: this file and backtest.py
  policies/    the only writable area
    rules/<policyId>.json        the draft rule (exactly one file, named after task.json's policyId)
    cases/<precedentId>.json     one case per precedent in task.json's overrides and controls

Case file:  {"precedentId": "PRC-0001", "expected": "<the precedent's decision, verbatim>"}
The harness derives every fact of a case from data/, never from the case file. A case for an unknown
precedent, a precedent outside this draft, or an `expected` that differs from the recorded decision fails.

Rule file:
  {
    "policyId": "pol-014", "title": "...",
    "when": "English condition", "then": "English action",
    "match":  {...},   every condition must hold for the rule to apply
    "effect": {...}    what the rule does to the proposed restriction steps when it applies
  }

match keys (facts are derived per case at the precedent's decision date; days late and renewal come from
the precedent's situation note when it states them, otherwise from invoices and renewal dates in data/):
  renewal_within_days: int     contract renewal is 0..N days away
  tier_in: [int]               client tier (1 best .. 5)
  days_late_gte: int           oldest unpaid invoice is at least N days past due
  days_late_lte: int           ... at most N days past due
  hedged: bool                 client has open hedged positions
  strategic: bool              client is strategic
  segment_in: [str]            client segment, e.g. "Hedge fund"
  proposed_levers_any: [str]   the proposal touches one of these levers

effect keys:
  exclude_levers: [lever]      drop proposed steps on these levers
  only_levers: [lever]         keep only proposed steps on these levers
  max_step: STEP               nothing harsher than STEP: keep only steps on STEP's lever, and lower a
                               harsher step on that lever to STEP (gentleness from capability.json)

Levers: withdrawals, trading, api, financing. Steps come from capability.json.

A case passes when applying the rule to the precedent's proposed steps gives the steps the person
actually decided: "Rejected" means none of the proposed steps, "Approved" means all of them, any other
decision is read as the steps it names (e.g. "Hold amount owed only" = withdrawals:HOLD_AMOUNT_OWED).

The last line of output is `RESULT <json>`. Exit code 0 when every case passes.
"""

import json
import re
import sys
from datetime import date
from pathlib import Path

LEVERS = ("withdrawals", "trading", "api", "financing")
PRODUCT_LEVER = {"CUSTODY": "withdrawals", "TRADING": "trading", "API": "api", "FINANCING": "financing"}
MATCH_TYPES = {
    "renewal_within_days": "int",
    "tier_in": "int_list",
    "days_late_gte": "int",
    "days_late_lte": "int",
    "hedged": "bool",
    "strategic": "bool",
    "segment_in": "str_list",
    "proposed_levers_any": "lever_list",
}
EFFECT_TYPES = {"exclude_levers": "lever_list", "only_levers": "lever_list", "max_step": "step"}
RULE_KEYS = {"policyId", "title", "when", "then", "match", "effect"}
CASE_KEYS = {"precedentId", "expected"}
PHRASES = [
    (r"\bhold (?:the )?amount owed\b|\bhold \$[\d,.]+ of .*withdrawals\b", "withdrawals", "HOLD_AMOUNT_OWED"),
    (r"\bfull freeze\b", "withdrawals", "FULL_FREEZE"),
    (r"\bno new positions\b", "trading", "NO_NEW_POSITIONS"),
    (r"\bclose[- ]only\b", "trading", "CLOSE_ONLY"),
    (r"\bpause otc\b", "trading", "PAUSE_OTC"),
    (r"\bread[- ]only\b", "api", "READ_ONLY"),
    (r"\brate[- ]limit\b", "api", "RATE_LIMIT"),
    (r"\bprepay\b", "api", "REQUIRE_PREPAY"),
    (r"\bno new borrowing\b", "financing", "NO_NEW_BORROWING"),
    (r"\blower (?:the )?(?:credit )?line\b", "financing", "LOWER_LINE"),
]
LIVE_TITLE = re.compile(r"^([a-z ]+) on .+'s (withdrawals|trading|api|financing)$")
LATE = re.compile(r"\blate (\d+) days?\b", re.IGNORECASE)
RENEWAL = re.compile(r"\brenewal in (\d+) days?\b", re.IGNORECASE)
NO_RENEWAL = re.compile(r"\bno renewal\b", re.IGNORECASE)


def load_json(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_data(data_dir: Path) -> dict:
    names = ["task", "precedents", "clients", "contracts", "invoices", "payments", "positions", "levers",
             "capability", "policies"]
    return {name: load_json(data_dir / f"{name}.json") for name in names}


def days_between(start: str, end: str) -> int:
    return (date.fromisoformat(end) - date.fromisoformat(start)).days


def parse_actions(text: str) -> frozenset | None:
    """The restriction steps a proposal or decision names, as 'lever:STEP'. None if it names none."""
    t = (text or "").strip()
    live = LIVE_TITLE.match(t.lower())
    if live:
        return frozenset({f"{live.group(2)}:{live.group(1).strip().upper().replace(' ', '_')}"})
    found = {f"{lever}:{step}" for pattern, lever, step in PHRASES if re.search(pattern, t, re.IGNORECASE)}
    return frozenset(found) or None


def decided_actions(precedent: dict) -> frozenset | None:
    decision = (precedent.get("decision") or "").strip()
    if decision == "Rejected":
        return frozenset() if parse_actions(precedent.get("proposed", "")) is not None else None
    if decision == "Approved":
        return parse_actions(precedent.get("proposed", ""))
    return parse_actions(decision)


def lever_of(action: str) -> str:
    return action.split(":", 1)[0]


def gentleness(capability: list) -> dict:
    return {(c["lever"], c["step"]): c["gentleness"] for c in capability}


def renewal_dates(client_id: str, data: dict) -> list:
    dates = set()
    client = data["clients"].get(client_id) or {}
    if client.get("renewal_on"):
        dates.add(client["renewal_on"])
    for p in data["precedents"]:
        m = RENEWAL.search(p.get("situation") or "")
        if p["client_id"] == client_id and m:
            dates.add(date.fromordinal(date.fromisoformat(p["decided_on"]).toordinal() + int(m.group(1))).isoformat())
    return sorted(dates)


def days_late_on(client_id: str, on: str, data: dict) -> int | None:
    late = [
        days_between(i["due_on"], on)
        for i in data["invoices"]
        if i["client_id"] == client_id and i["status"] not in ("void", "disputed") and i["due_on"] < on
        and (not i.get("paid_on") or i["paid_on"] > on)
    ]
    return max(late) if late else None


def facts_at(client_id: str, on: str, data: dict, situation: str = "", proposed: frozenset = frozenset()) -> dict:
    client = data["clients"].get(client_id) or {}
    m = LATE.search(situation)
    late = int(m.group(1)) if m else days_late_on(client_id, on, data)
    m = RENEWAL.search(situation)
    if m:
        renewal = int(m.group(1))
    elif NO_RENEWAL.search(situation):
        renewal = None
    else:
        ahead = [days_between(on, d) for d in renewal_dates(client_id, data) if d >= on]
        renewal = min(ahead) if ahead else None
    hedged = any(
        p["client_id"] == client_id and p.get("status") == "open" and p.get("hedge_group") for p in data["positions"]
    )
    return {
        "client_id": client_id,
        "on": on,
        "tier": client.get("tier"),
        "strategic": bool(client.get("strategic")),
        "segment": client.get("segment"),
        "days_late": late,
        "renewal_in_days": renewal,
        "hedged": hedged,
        "proposed_actions": sorted(proposed),
    }


def precedent_facts(precedent: dict, data: dict) -> dict:
    proposed = parse_actions(precedent.get("proposed", "")) or frozenset()
    return facts_at(precedent["client_id"], precedent["decided_on"], data, precedent.get("situation") or "", proposed)


def _typed(value, kind: str, steps: set) -> bool:
    if kind == "int":
        return type(value) is int
    if kind == "bool":
        return type(value) is bool
    if kind == "step":
        return isinstance(value, str) and value in steps
    if not isinstance(value, list) or not value:
        return False
    if kind == "int_list":
        return all(type(v) is int for v in value)
    if kind == "str_list":
        return all(isinstance(v, str) and v for v in value)
    if kind == "lever_list":
        return all(v in LEVERS for v in value)
    return False


def validate_rule(rule, policy_id: str, capability: list) -> list:
    if not isinstance(rule, dict):
        return ["the rule file must hold a JSON object"]
    steps = {c["step"] for c in capability}
    errors = []
    missing = RULE_KEYS - set(rule)
    extra = set(rule) - RULE_KEYS
    if missing:
        errors.append(f"missing keys: {', '.join(sorted(missing))}")
    if extra:
        errors.append(f"unknown keys: {', '.join(sorted(extra))}")
    if rule.get("policyId") != policy_id:
        errors.append(f"policyId must be {policy_id!r}")
    for key in ("title", "when", "then"):
        if key in rule and not (isinstance(rule[key], str) and rule[key].strip()):
            errors.append(f"{key} must be a non-empty string")
    for key, types in (("match", MATCH_TYPES), ("effect", EFFECT_TYPES)):
        block = rule.get(key)
        if not isinstance(block, dict) or not block:
            errors.append(f"{key} must be a non-empty object")
            continue
        for name, value in block.items():
            if name not in types:
                errors.append(f"{key}.{name} is not a known key (known: {', '.join(sorted(types))})")
            elif not _typed(value, types[name], steps):
                errors.append(f"{key}.{name} has the wrong type or value: {value!r}")
    return errors


def matches(match: dict, facts: dict) -> bool:
    for name, value in match.items():
        if name == "renewal_within_days":
            r = facts["renewal_in_days"]
            ok = r is not None and 0 <= r <= value
        elif name == "tier_in":
            ok = facts["tier"] in value
        elif name == "days_late_gte":
            ok = facts["days_late"] is not None and facts["days_late"] >= value
        elif name == "days_late_lte":
            ok = facts["days_late"] is not None and facts["days_late"] <= value
        elif name == "hedged":
            ok = facts["hedged"] is value
        elif name == "strategic":
            ok = facts["strategic"] is value
        elif name == "segment_in":
            ok = facts["segment"] in value
        elif name == "proposed_levers_any":
            ok = any(lever_of(a) in value for a in facts["proposed_actions"])
        else:
            ok = False
        if not ok:
            return False
    return True


def apply_rule(rule: dict, facts: dict, actions: frozenset, capability: list) -> frozenset:
    """The steps left after the rule acts on the proposed steps. The current rule is the identity."""
    if not matches(rule["match"], facts):
        return frozenset(actions)
    effect = rule["effect"]
    out = set(actions)
    if "only_levers" in effect:
        out = {a for a in out if lever_of(a) in effect["only_levers"]}
    if "exclude_levers" in effect:
        out = {a for a in out if lever_of(a) not in effect["exclude_levers"]}
    if "max_step" in effect:
        rank = gentleness(capability)
        cap_lever = next(lever for lever, step in rank if step == effect["max_step"])
        cap = rank[(cap_lever, effect["max_step"])]
        capped = set()
        for a in out:
            lever, step = a.split(":", 1)
            if lever != cap_lever:
                continue
            capped.add(a if rank.get((lever, step), cap + 1) <= cap else f"{lever}:{effect['max_step']}")
        out = capped
    return frozenset(out)


def read_rule(policies_dir: Path, policy_id: str):
    rules_dir = policies_dir / "rules"
    found = sorted(p.name for p in rules_dir.glob("*.json")) if rules_dir.is_dir() else []
    errors = [f"unexpected rule file rules/{name}" for name in found if name != f"{policy_id}.json"]
    path = rules_dir / f"{policy_id}.json"
    if not path.is_file():
        return None, errors + [f"missing rules/{policy_id}.json"]
    try:
        return load_json(path), errors
    except (OSError, ValueError) as e:
        return None, errors + [f"rules/{policy_id}.json is not valid JSON: {e}"]


def run_cases(root: Path) -> dict:
    data = load_data(root / "data")
    task = data["task"]
    policy_id = task["policyId"]
    by_id = {p["id"]: p for p in data["precedents"]}
    kinds = {pid: "override" for pid in task["overrides"]} | {pid: "control" for pid in task["controls"]}
    failures, cases = [], []

    rule, rule_errors = read_rule(root / "policies", policy_id)
    if rule is not None:
        rule_errors += validate_rule(rule, policy_id, data["capability"])
    failures += [f"rule: {e}" for e in rule_errors]

    seen = set()
    cases_dir = root / "policies" / "cases"
    for path in sorted(cases_dir.glob("*.json")) if cases_dir.is_dir() else []:
        name = f"cases/{path.name}"
        try:
            case = load_json(path)
        except (OSError, ValueError) as e:
            failures.append(f"{name}: not valid JSON: {e}")
            continue
        if not isinstance(case, dict) or set(case) != CASE_KEYS:
            failures.append(f"{name}: must be exactly {{\"precedentId\", \"expected\"}}")
            continue
        pid = case["precedentId"]
        if path.stem != pid:
            failures.append(f"{name}: file must be named {pid}.json")
            continue
        precedent = by_id.get(pid)
        if precedent is None:
            failures.append(f"{name}: unknown precedent {pid}")
            continue
        if pid not in kinds:
            failures.append(f"{name}: {pid} is not one of this draft's precedents")
            continue
        if case["expected"] != precedent["decision"]:
            failures.append(f"{name}: expected {case['expected']!r} but {pid}'s recorded decision is "
                            f"{precedent['decision']!r}")
            continue
        seen.add(pid)
        facts = precedent_facts(precedent, data)
        proposed = parse_actions(precedent["proposed"]) or frozenset()
        want = decided_actions(precedent)
        got = apply_rule(rule, facts, proposed, data["capability"]) if rule is not None and not rule_errors else None
        ok = want is not None and got == want
        cases.append({
            "precedentId": pid, "kind": kinds[pid], "facts": facts, "proposed": sorted(proposed),
            "expected": sorted(want) if want is not None else None, "got": sorted(got) if got is not None else None,
            "ok": ok,
        })
        if not ok:
            failures.append(f"{name}: rule gives {sorted(got) if got is not None else 'nothing (rule invalid)'}, "
                            f"the decision was {sorted(want) if want is not None else 'not a restriction'}")
    for pid in sorted(set(kinds) - seen):
        if not any(f.startswith(f"cases/{pid}.json") for f in failures):
            failures.append(f"cases/{pid}.json: missing ({kinds[pid]})")
    total = len(kinds)
    passed = sum(1 for c in cases if c["ok"])
    return {"ok": not failures and passed == total, "passed": passed, "total": total, "failures": failures,
            "cases": cases}


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    result = run_cases(root)
    for case in result["cases"]:
        f = case["facts"]
        renewal = "none" if f["renewal_in_days"] is None else f"{f['renewal_in_days']}d"
        print(f"{'PASS' if case['ok'] else 'FAIL'} {case['precedentId']} ({case['kind']}): "
              f"proposed {case['proposed']} -> rule {case['got']} · decided {case['expected']} · "
              f"late {f['days_late']}d, renewal {renewal}, tier {f['tier']}, hedged {f['hedged']}")
    for failure in result["failures"]:
        print(f"ERROR {failure}")
    print(f"{result['passed']}/{result['total']} cases pass" + ("" if result["ok"] else " · FAILED"))
    print("RESULT " + json.dumps({k: result[k] for k in ("ok", "passed", "total", "failures")}))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
