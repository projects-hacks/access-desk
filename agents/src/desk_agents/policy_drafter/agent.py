import asyncio
import difflib
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import anthropic
import httpx

from ..agents.base import Agent
from ..config import settings
from ..models import Proposal, Role, WorkItemKind
from ..stdb import ReducerError, SpacetimeClient
from . import snapshot
from .families import FAMILIES, Family, group
from .sandbox import Sandbox, Workspace

log = logging.getLogger("desk_agents.policy_drafter")

OPEN = {"PROPOSED", "NEEDS_INFO"}
MAX_STEPS = 200
Row = dict[str, Any]


@dataclass
class Job:
    family: Family
    policy_id: str
    version: int
    revision: int
    overrides: list[str]
    controls: list[str]
    revised_from: int | None = None
    note: str = ""
    previous_rule: dict[str, Any] | None = None

    @property
    def subject_id(self) -> str:
        return f"policy_draft:{self.family.name}:{self.policy_id}@{self.version}:r{self.revision}"

    @property
    def key(self) -> tuple:
        return self.family.name, self.revision, tuple(self.overrides)

    def task(self) -> Row:
        return {
            "family": self.family.name, "policyRefs": list(self.family.policy_refs), "policyId": self.policy_id,
            "version": self.version, "revision": self.revision, "overrides": self.overrides,
            "controls": self.controls, "revisedFrom": self.revised_from, "rejectionNote": self.note,
            "previousRule": self.previous_rule, "paidWithinDays": settings.policy_draft_paid_within_days,
            "transitDays": settings.policy_draft_transit_days,
        }


@dataclass
class Outcome:
    job: Job
    runner: str
    sandbox: Sandbox
    workspace: Workspace
    data: dict[str, Any]
    finished: bool
    error: str | None = None
    rule: Row | None = None
    tests: Row = field(default_factory=dict)
    backtest: Row = field(default_factory=dict)


Runner = Callable[[Sandbox, Row, Workspace], Awaitable[bool]]


class PolicyDrafter(Agent):
    """
    Drafts a policy change once enough people override the same policy the same way. The work runs in a
    sandboxed Factory Droid (Claude directly when the Droid is unavailable). It only ever drafts: the
    draft is saved with status `draft` and a controller decides on the POLICY_DRAFT work item.
    """

    name = "policy-drafter"

    def __init__(self, db: SpacetimeClient, droid: Runner | None = None, claude: Runner | None = None,
                 workspace_parent: str | None = None):
        super().__init__(db)
        self.acted = 0
        self.droid = droid
        self.claude = claude
        self.workspace_parent = workspace_parent
        self.running: dict[str, asyncio.Task] = {}
        self.stopped: set[str] = set()
        self.failed: set[tuple] = set()
        self.unavailable: set[str] = set()
        self.closed_without_note: set[int] = set()
        self._said_unavailable = False

    async def run(self) -> list[Proposal]:
        self.acted = self.collect()
        if not self.can_draft():
            return []
        precedents = None
        drafts = None
        for family in FAMILIES:
            if family.name in self.running or family.name in self.stopped:
                continue
            if precedents is None:
                precedents = self.db.sql("SELECT * FROM precedent")
                drafts = self.db.sql("SELECT * FROM work_item WHERE kind = 'POLICY_DRAFT'")
            job = self.due(family, precedents, drafts)
            if job:
                self.start(job)
        return []

    async def wait(self) -> int:
        """Waits for running drafts and files them. For tests and one-off runs."""
        if self.running:
            await asyncio.gather(*self.running.values(), return_exceptions=True)
        return self.collect()

    # ── Is anything due? ───────────────────────────────────────────────────

    def can_draft(self) -> bool:
        if self.droid or self.claude:
            return True
        from .droid_runner import droid_available

        if droid_available(settings.droid_executable, settings.factory_api_key) is None:
            return True
        if settings.anthropic_api_key:
            return True
        if not self._said_unavailable:
            log.warning("[%s] drafting unavailable: no droid CLI with FACTORY_API_KEY and no ANTHROPIC_API_KEY",
                        self.name)
            self._said_unavailable = True
        return False

    def due(self, family: Family, precedents: list[Row], drafts: list[Row]) -> Job | None:
        mine = sorted((d for d in drafts if d["subject_id"].startswith(f"policy_draft:{family.name}:")),
                      key=lambda d: d["id"])
        if any(d["state"] in OPEN for d in mine):
            return None
        proposals = {d["id"]: json.loads(d["proposal_json"] or "{}") for d in mine}
        if any(d["state"] == "REJECTED" and proposals[d["id"]].get("revision") == 2 for d in mine):
            log.info("[%s] %s: revision 2 was rejected; not drafting this family again", self.name, family.name)
            self.stopped.add(family.name)
            return None
        revised = {p.get("revisedFrom") for p in proposals.values()}
        for d in mine:
            p = proposals[d["id"]]
            if d["state"] != "REJECTED" or p.get("revision") != 1 or d["id"] in revised:
                continue
            if d["id"] in self.closed_without_note:
                continue
            note = self.rejection_note(d["id"])
            if not note:
                log.info("[%s] %s: WI-%s rejected without a note; no revision", self.name, family.name, d["id"])
                self.closed_without_note.add(d["id"])
                continue
            job = Job(family=family, policy_id=p["policyId"], version=0, revision=2,
                      overrides=p["precedentIds"], controls=p.get("controlPrecedentIds", []), revised_from=d["id"],
                      note=note, previous_rule=p.get("ruleAfter"))
            return self.versioned(job, proposals.values())
        covered = {pid for p in proposals.values() for pid in p.get("precedentIds", [])}
        groups = group(precedents)[family.name]
        overrides = [p["id"] for p in groups["overrides"] if p["id"] not in covered]
        if len(overrides) < settings.policy_draft_threshold:
            return None
        job = Job(family=family, policy_id=family.draft_policy_id, version=0, revision=1, overrides=overrides,
                  controls=[p["id"] for p in groups["controls"]])
        return self.versioned(job, proposals.values())

    def versioned(self, job: Job, proposals) -> Job | None:
        if job.key in self.failed:
            return None
        pid = job.policy_id.replace("'", "''")
        versions = [r["version"] for r in self.db.sql(f"SELECT * FROM policy WHERE policy_id = '{pid}'")]
        versions += [p.get("version") or 0 for p in proposals if p.get("policyId") == job.policy_id]
        job.version = max(versions, default=0) + 1
        return job

    def rejection_note(self, work_item_id: int) -> str:
        events = self.db.sql(f"SELECT * FROM audit_event WHERE work_item_id = {int(work_item_id)}")
        rejected = [e for e in events if e.get("to_state") == "REJECTED" and e.get("allowed")]
        return (max(rejected, key=lambda e: e["id"])["detail"] or "").strip() if rejected else ""

    # ── Drafting ───────────────────────────────────────────────────────────

    def start(self, job: Job) -> None:
        task = job.task()
        data = snapshot.take(self.db, task, job.family.policy_refs, job.policy_id)
        workspace = Workspace.create(data, self.workspace_parent)
        log.info("[%s] drafting %s@%s r%s from %s in %s", self.name, job.policy_id, job.version, job.revision,
                 ", ".join(job.overrides), workspace.root)
        self.running[job.family.name] = asyncio.create_task(self.draft(job, data, workspace))

    async def draft(self, job: Job, data: dict[str, Any], workspace: Workspace) -> Outcome:
        task = data["task"]
        sandbox = Sandbox(workspace.root, job.policy_id)
        sandbox.record("plan", f"{len(job.overrides)} overrides of {', '.join(job.family.policy_refs)} "
                               f"({', '.join(job.overrides)}); draft {job.policy_id}@{job.version} r{job.revision}")
        runner, finished, error = "none", False, None
        for n, (name, run) in enumerate(self.runners()):
            runner = name
            if n:
                clear(sandbox)
            try:
                finished = await run(sandbox, task, workspace)
                error = None if finished else f"{name} run did not finish"
            except Exception as e:
                finished, error = False, f"{type(e).__name__}: {e}"[:300]
                log.exception("[%s] %s runner failed", self.name, name)
                sandbox.record(name, f"runner failed: {error}", "failed")
            if finished or sandbox.submitted:
                break
        outcome = Outcome(job=job, runner=runner, sandbox=sandbox, workspace=workspace, data=data,
                          finished=finished, error=error)
        await asyncio.to_thread(self.verify, outcome)
        return outcome

    def runners(self) -> list[tuple[str, Runner]]:
        out = []
        if self.droid:
            out.append(("droid", self.droid))
        elif not self.claude:
            from .droid_runner import droid_available

            why = droid_available(settings.droid_executable, settings.factory_api_key)
            if why is None:
                out.append(("droid", default_droid))
            else:
                log.info("[%s] Droid unavailable (%s); using Claude", self.name, why)
        if self.claude:
            out.append(("claude", self.claude))
        elif settings.anthropic_api_key:
            out.append(("claude", default_claude))
        return out

    def verify(self, outcome: Outcome) -> None:
        """Python re-runs the harness itself; nothing the model reports about its own tests is trusted."""
        sandbox = outcome.sandbox
        if not sandbox.submitted:
            sandbox.record("submit_draft", "the run ended without submit_draft", "failed")
        path = sandbox.policies / "rules" / f"{outcome.job.policy_id}.json"
        try:
            outcome.rule = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            outcome.error = outcome.error or f"no readable rule file: {e}"
            return
        outcome.tests = sandbox.harness_result("run_tests.py")
        sandbox.record("run_tests", f"desk re-run: {outcome.tests.get('passed')}/{outcome.tests.get('total')} pass",
                       "done" if outcome.tests.get("ok") else "failed")
        if outcome.tests.get("ok"):
            outcome.backtest = sandbox.harness_result("backtest.py")
            b = outcome.backtest
            sandbox.record("backtest", f"desk re-run: {b.get('casesChanged')} of {b.get('episodes')} episodes change",
                           "done" if b.get("ok") else "failed")

    # ── Filing ─────────────────────────────────────────────────────────────

    def collect(self) -> int:
        writes = 0
        for name, task in list(self.running.items()):
            if not task.done():
                continue
            del self.running[name]
            try:
                outcome = task.result()
            except Exception:
                log.exception("[%s] %s draft crashed", self.name, name)
                continue
            writes += self.file(outcome)
        return writes

    def file(self, o: Outcome) -> int:
        job, sandbox = o.job, o.sandbox
        if o.rule is None or not o.tests.get("ok") or not o.backtest.get("ok"):
            if o.rule is None:
                why = o.error or "no draft"
            elif not o.tests.get("ok"):
                why = "tests failed: " + "; ".join(o.tests.get("failures") or o.tests.get("errors") or [])[:300]
            else:
                why = "backtest failed: " + "; ".join(o.backtest.get("errors") or [])[:300]
            log.warning("[%s] %s r%s not filed (%s); workspace kept at %s", self.name, job.policy_id, job.revision,
                        why, o.workspace.root)
            self.failed.add(job.key)
            return 0
        rule = o.rule
        rule_json = {k: rule[k] for k in ("when", "then", "match", "effect")}
        base = self.base_rule(job.family, o.data["policies"])
        diff = unified_diff(base, rule_json, job)
        sandbox.record("diff", f"{job.family.base_policy_id} -> {job.policy_id}@{job.version}: "
                               f"{sum(1 for ln in diff.splitlines() if ln[:1] in '+-' and ln[:3] not in ('+++', '---'))}"
                               " changed lines")
        writes = 0
        try:
            self.db.call("upsert_policy", job.policy_id, job.version, "draft", rule["title"], json.dumps(rule_json),
                         ",".join(job.overrides), {"none": []})
            writes += 1
        except (ReducerError, httpx.HTTPError) as e:
            log.warning("[%s] upsert_policy %s@%s failed: %s", self.name, job.policy_id, job.version, e)
            self.failed.add(job.key)
            return writes
        steps = [s.row() for s in sandbox.steps][-MAX_STEPS:]
        b = o.backtest
        proposal = Proposal(
            kind=WorkItemKind.POLICY_DRAFT,
            client_id="",
            subject_id=job.subject_id,
            title=f"Draft {job.policy_id}@{job.version}: {rule['title']}"
                  + (f" (revision {job.revision})" if job.revision > 1 else ""),
            amount_cents=0,
            proposal={
                "family": job.family.name, "policyId": job.policy_id, "version": job.version,
                "revision": job.revision, "revisedFrom": job.revised_from, "rejectionNote": job.note or None,
                "ruleBefore": base, "ruleAfter": rule_json, "diff": diff,
                "precedentIds": job.overrides, "controlPrecedentIds": job.controls,
                "tests": {k: o.tests.get(k) for k in ("ok", "passed", "total", "failures")},
                "backtest": {k: b.get(k) for k in ("window", "episodes", "restrictedUnderCurrent", "casesChanged",
                                                   "changed", "money", "wronglyRestricted", "assumptions")},
                "runner": o.runner, "modelSummary": (sandbox.submitted or {}).get("summary"),
                "investigation": steps,
            },
            reasoning=reasoning(job, o),
            policy_ref=job.policy_id,
            confidence=0.7,
            required_role=Role.CONTROLLER,
        )
        try:
            self.db.propose(proposal)
            writes += 1
        except (ReducerError, httpx.HTTPError) as e:
            log.warning("[%s] filing %s failed: %s", self.name, job.subject_id, e)
            self.failed.add(job.key)
            return writes
        sid = job.subject_id.replace("'", "''")
        rows = self.db.sql(f"SELECT * FROM work_item WHERE subject_id = '{sid}'")
        if rows and "record_investigation" not in self.unavailable:
            item_id = max(r["id"] for r in rows)
            try:
                self.db.record_investigation(item_id, steps)
                writes += 1
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    self.unavailable.add("record_investigation")
                    log.warning("[%s] record_investigation is not published yet; steps stay in the proposal JSON",
                                self.name)
                else:
                    log.warning("[%s] record_investigation WI-%s failed: %s", self.name, item_id, e)
            except (ReducerError, httpx.HTTPError) as e:
                log.warning("[%s] record_investigation WI-%s failed: %s", self.name, item_id, e)
        log.info("[%s] filed %s (%s steps, via %s)", self.name, job.subject_id, len(steps), o.runner)
        o.workspace.remove()
        return writes

    @staticmethod
    def base_rule(family: Family, policies: list[Row]) -> Row:
        rows = [p for p in policies if p["policy_id"] == family.base_policy_id and p["status"] == "active"]
        if not rows:
            return {"policyId": family.base_policy_id, "version": None, "ruleJson": None}
        row = max(rows, key=lambda p: p["version"])
        return {"policyId": row["policy_id"], "version": row["version"], "title": row["title"],
                "ruleJson": json.loads(row["rule_json"])}


def clear(sandbox: Sandbox) -> None:
    """A fallback runner starts from an empty policies/ area."""
    for sub in ("rules", "cases"):
        for path in (sandbox.policies / sub).glob("*"):
            if path.is_file() or path.is_symlink():
                path.unlink()
    sandbox.submitted = None
    sandbox.record("fallback", "cleared policies/ for the next runner")


def unified_diff(base: Row, after: Row, job: Job) -> str:
    before = json.dumps(base.get("ruleJson") or {}, indent=2, sort_keys=True).splitlines()
    now = json.dumps(after, indent=2, sort_keys=True).splitlines()
    return "\n".join(difflib.unified_diff(
        before, now, fromfile=f"{base['policyId']}@{base.get('version')}/rule_json",
        tofile=f"{job.policy_id}@{job.version}/rule_json", lineterm="",
    ))


def reasoning(job: Job, o: Outcome) -> str:
    b, money = o.backtest, o.backtest.get("money", {})
    wrong = b.get("wronglyRestricted", {})
    parts = [
        (f"{len(job.overrides)} overrides of {'/'.join(job.family.policy_refs)} ({', '.join(job.overrides)}) "
        f"that no draft covers yet."),
        f"Rule: when {o.rule['when']}, {o.rule['then']}.",
        (f"Tests: {o.tests.get('passed')}/{o.tests.get('total')} precedents reproduced, including "
        f"{len(job.controls)} confirmed decisions left unchanged."),
        (f"Backtest over {b.get('episodes')} default episodes: {b.get('casesChanged')} change; withdrawals held "
        f"${money.get('current', {}).get('restrictedCents', 0) / 100:,.2f} -> "
        f"${money.get('draft', {}).get('restrictedCents', 0) / 100:,.2f}; lever steps "
        f"{money.get('current', {}).get('leverSteps')} -> {money.get('draft', {}).get('leverSteps')}; wrongly "
        f"restricted episodes {wrong.get('current', {}).get('episodes')} -> {wrong.get('draft', {}).get('episodes')}."),
        "Draft only: a controller activates it.",
    ]
    if job.revision > 1:
        parts.insert(0, f"Revision {job.revision} of WI-{job.revised_from}, addressing: “{job.note}”.")
    return " ".join(parts)


async def default_droid(sandbox: Sandbox, task: Row, workspace: Workspace) -> bool:
    from .droid_runner import run_droid

    return await run_droid(sandbox, task, executable=settings.droid_executable, api_key=settings.factory_api_key,
                           model=settings.droid_model, timeout=settings.policy_draft_timeout_seconds,
                           bin_dir=workspace.bin)


async def default_claude(sandbox: Sandbox, task: Row, workspace: Workspace) -> bool:
    from .claude_runner import run_claude

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=settings.policy_draft_timeout_seconds)
    return await asyncio.wait_for(
        asyncio.to_thread(run_claude, sandbox, task, client=client, model=settings.anthropic_model,
                          max_turns=settings.policy_draft_max_turns),
        timeout=settings.policy_draft_timeout_seconds,
    )
