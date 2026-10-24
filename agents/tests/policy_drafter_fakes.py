import copy
import json
import re
from pathlib import Path

import httpx

from desk_agents.policy_drafter import snapshot
from desk_agents.policy_drafter.families import group
from desk_agents.policy_drafter.sandbox import Sandbox, Workspace

FIXTURE = Path(__file__).parent / "fixtures" / "policy_history.json"
QUERY = re.compile(r"^SELECT \* FROM (\w+)(?: WHERE (\w+) = ('(?:[^']|'')*'|\d+))?$")
REFS = ("pol-003", "pol-006")

RULE = {
    "policyId": "pol-014",
    "title": "Near renewal, hold the amount owed only",
    "when": "a restriction is due and the client's contract renews within 14 days",
    "then": "hold the amount owed on withdrawals and leave trading, API and financing untouched",
    "match": {"renewal_within_days": 14},
    "effect": {"max_step": "HOLD_AMOUNT_OWED"},
}


def history(live_override: bool = True) -> dict:
    tables = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if not live_override:
        tables["precedent"] = [p for p in tables["precedent"] if p["source"] != "live"]
    tables.setdefault("work_item", [])
    tables.setdefault("audit_event", [])
    return tables


class FakeDb:
    """Serves the fixture tables to SELECT queries and records reducer calls. Never talks to a database."""

    def __init__(self, tables: dict, missing: tuple[str, ...] = ()):
        self.tables = copy.deepcopy(tables)
        self.missing = set(missing)
        self.queries: list[str] = []
        self.calls: list[tuple] = []

    def sql(self, query: str) -> list[dict]:
        self.queries.append(query)
        table, column, value = QUERY.match(query.strip()).groups()
        rows = self.tables.get(table, [])
        if column:
            wanted = int(value) if value.isdigit() else value[1:-1].replace("''", "'")
            rows = [r for r in rows if r.get(column) == wanted]
        return copy.deepcopy(rows)

    def call(self, reducer: str, *args) -> None:
        if reducer in self.missing:
            request = httpx.Request("POST", f"http://db/call/{reducer}")
            raise httpx.HTTPStatusError("not found", request=request, response=httpx.Response(404, request=request))
        self.calls.append((reducer, args))

    def propose(self, p) -> None:
        self.calls.append(("propose_work_item", p))
        item_id = 1 + max((w["id"] for w in self.tables["work_item"]), default=100)
        self.tables["work_item"].append({
            "id": item_id, "kind": p.kind.value, "client_id": p.client_id, "subject_id": p.subject_id,
            "state": "PROPOSED", "title": p.title, "proposal_json": json.dumps(p.proposal), "reasoning": p.reasoning,
            "policy_ref": p.policy_ref, "required_role": p.required_role.value,
        })

    def record_investigation(self, work_item_id: int, steps: list[dict]) -> None:
        self.call("record_investigation", work_item_id, steps)

    def decide(self, work_item_id: int, state: str, note: str = "") -> None:
        item = next(w for w in self.tables["work_item"] if w["id"] == work_item_id)
        item["state"] = state
        self.tables["audit_event"].append({
            "id": len(self.tables["audit_event"]) + 1, "work_item_id": work_item_id, "to_state": state,
            "allowed": True, "detail": note,
        })

    def proposals(self) -> list:
        return [args for name, args in self.calls if name == "propose_work_item"]

    def reducer(self, name: str) -> list[tuple]:
        return [args for n, args in self.calls if n == name]


def workspace(tmp: str, tables: dict | None = None, policy_id: str = "pol-014") -> tuple[Workspace, Sandbox, dict]:
    tables = tables or history()
    g = group(tables["precedent"])["restriction_ladder"]
    task = {
        "family": "restriction_ladder", "policyRefs": list(REFS), "policyId": policy_id, "version": 1,
        "revision": 1, "overrides": [p["id"] for p in g["overrides"]], "controls": [p["id"] for p in g["controls"]],
        "paidWithinDays": 5, "transitDays": 3,
    }
    data = snapshot.take(FakeDb(tables), task, REFS, policy_id)
    ws = Workspace.create(data, tmp)
    return ws, Sandbox(ws.root, policy_id), data


def write_cases(sandbox: Sandbox, data: dict, ids=None) -> None:
    task, by_id = data["task"], {p["id"]: p for p in data["precedents"]}
    for pid in ids if ids is not None else task["overrides"] + task["controls"]:
        sandbox.write_file(f"policies/cases/{pid}.json",
                           json.dumps({"precedentId": pid, "expected": by_id[pid]["decision"]}))


def scripted(rule: dict | None = None, seen: list | None = None):
    """A stand-in for the model: does the work through the sandbox's tools, as the prompt asks."""

    async def run(sandbox: Sandbox, task: dict, ws: Workspace) -> bool:
        if seen is not None:
            seen.append(task)
        data = {"task": json.loads(sandbox.read_file("data/task.json")),
                "precedents": json.loads(sandbox.read_file("data/precedents.json"))}
        sandbox.report_step("plan", "cases first, then the rule")
        write_cases(sandbox, data)
        sandbox.write_file(f"policies/rules/{task['policyId']}.json", json.dumps({**(rule or RULE),
                                                                               "policyId": task["policyId"]}))
        sandbox.run_command("python harness/run_tests.py")
        sandbox.run_command("python harness/backtest.py")
        sandbox.submit_draft(task["policyId"], "Near renewal, hold the amount owed only.")
        return True

    return run
