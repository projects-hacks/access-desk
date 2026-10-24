import json
import logging
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger("desk_agents.policy_drafter")

HARNESS_DIR = Path(__file__).parent / "harness"
HARNESS_FILES = ("run_tests.py", "backtest.py")
ALLOWED_COMMANDS = {
    "python harness/run_tests.py": "run_tests.py",
    "python harness/backtest.py": "backtest.py",
}
SECRET_ENV = (
    "ANTHROPIC_API_KEY", "STDB_TOKEN", "STDB_AGENT_TOKEN", "STDB_GATEWAY_TOKEN", "STDB_DEMO_TOKEN",
    "VITE_STDB_CONTROLLER_TOKEN", "NESSIE_API_KEY",
)
COMMAND_TIMEOUT = 120
MAX_READ = 200_000
MAX_SUMMARY = 300


@dataclass
class Step:
    tool: str
    summary: str
    status: str = "done"

    def row(self) -> dict[str, str]:
        return {"tool": self.tool, "summary": self.summary[:MAX_SUMMARY], "status": self.status}


@dataclass
class Workspace:
    """A fresh directory per run. Only policies/ is writable; harness/ and data/ are read-only copies."""

    base: Path
    root: Path
    bin: Path

    @classmethod
    def create(cls, data: dict[str, Any], parent: str | None = None) -> "Workspace":
        base = Path(tempfile.mkdtemp(prefix="policy-draft-", dir=parent)).resolve()
        root, bin_dir = base / "workspace", base / "bin"
        for sub in ("policies/rules", "policies/cases", "harness", "data"):
            (root / sub).mkdir(parents=True)
        for name in HARNESS_FILES:
            shutil.copyfile(HARNESS_DIR / name, root / "harness" / name)
        for name, value in data.items():
            (root / "data" / f"{name}.json").write_text(json.dumps(value, indent=1, default=str), encoding="utf-8")
        bin_dir.mkdir()
        (bin_dir / "python").symlink_to(sys.executable)
        for sub in ("harness", "data"):
            for path in (root / sub).iterdir():
                path.chmod(stat.S_IRUSR | stat.S_IRGRP)
            (root / sub).chmod(stat.S_IRUSR | stat.S_IXUSR)
        return cls(base=base, root=root, bin=bin_dir)

    def remove(self) -> None:
        for sub in ("harness", "data"):
            path = self.root / sub
            if path.exists():
                path.chmod(stat.S_IRWXU)
        shutil.rmtree(self.base, ignore_errors=True)


class Sandbox:
    """
    The tools a drafting run may use and the checks in front of them. The Droid permission handler and
    the Claude tools both call these, so the two runners see the same sandbox.
    """

    def __init__(self, workspace: Path, policy_id: str, python: str = sys.executable):
        self.root = Path(os.path.realpath(workspace))
        self.policies = self.root / "policies"
        self.policy_id = policy_id
        self.python = python
        self.steps: list[Step] = []
        self.submitted: dict[str, str] | None = None

    # ── Checks ─────────────────────────────────────────────────────────────

    def resolve(self, path: str) -> Path:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = self.root / p
        return Path(os.path.realpath(p))

    def can_write(self, path: str) -> bool:
        """Only files whose real path (after `..` and symlinks) lies under <workspace>/policies/."""
        if not path or "\x00" in path:
            return False
        real = self.resolve(path)
        return self.policies in real.parents

    def can_read(self, path: str) -> bool:
        if not path or "\x00" in path:
            return False
        real = self.resolve(path)
        return real == self.root or self.root in real.parents

    @staticmethod
    def can_execute(command: str) -> bool:
        return isinstance(command, str) and command.strip() in ALLOWED_COMMANDS

    # ── Log ────────────────────────────────────────────────────────────────

    def record(self, tool: str, summary: str, status: str = "done") -> None:
        self.steps.append(Step(tool, summary, status))

    def deny(self, tool: str, detail: str) -> str:
        log.warning("policy drafter denied %s: %s", tool, detail)
        self.record(tool, f"denied: {detail}", "denied")
        return f"Denied: {detail}. Only files under policies/ are writable and only " \
               f"`{'` and `'.join(ALLOWED_COMMANDS)}` may be run."

    # ── Tools ──────────────────────────────────────────────────────────────

    def read_file(self, path: str) -> str:
        if not self.can_read(path):
            return self.deny("read_file", f"read outside the workspace: {path}")
        real = self.resolve(path)
        if not real.is_file():
            return f"Not a file: {path}"
        text = real.read_text(encoding="utf-8", errors="replace")
        self.record("read_file", path)
        return text[:MAX_READ] + ("\n[truncated]" if len(text) > MAX_READ else "")

    def list_dir(self, path: str = ".") -> str:
        if not self.can_read(path):
            return self.deny("list_dir", f"list outside the workspace: {path}")
        real = self.resolve(path)
        if not real.is_dir():
            return f"Not a directory: {path}"
        self.record("list_dir", path)
        return "\n".join(f"{p.name}/" if p.is_dir() else p.name for p in sorted(real.iterdir())) or "(empty)"

    def search(self, pattern: str, path: str = ".") -> str:
        if not self.can_read(path):
            return self.deny("search", f"search outside the workspace: {path}")
        try:
            regex = re.compile(pattern)
        except re.error as e:
            return f"Invalid pattern: {e}"
        real = self.resolve(path)
        files = [real] if real.is_file() else sorted(p for p in real.rglob("*") if p.is_file())
        hits = []
        for f in files:
            if not self.can_read(str(f)):
                continue
            for n, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if regex.search(line):
                    hits.append(f"{f.relative_to(self.root)}:{n}: {line[:300]}")
                    if len(hits) >= 200:
                        break
        self.record("search", f"{pattern!r} in {path}: {len(hits)} hits")
        return "\n".join(hits) or "No matches."

    def write_file(self, path: str, content: str) -> str:
        if not self.can_write(path):
            return self.deny("write_file", f"write outside policies/: {path}")
        real = self.resolve(path)
        real.parent.mkdir(parents=True, exist_ok=True)
        if not self.can_write(str(real)):
            return self.deny("write_file", f"write outside policies/: {path}")
        real.write_text(content, encoding="utf-8")
        self.record("write_file", str(real.relative_to(self.root)))
        return f"Wrote {real.relative_to(self.root)} ({len(content)} chars)."

    def edit_file(self, path: str, old_text: str, new_text: str) -> str:
        if not self.can_write(path):
            return self.deny("edit_file", f"edit outside policies/: {path}")
        real = self.resolve(path)
        if not real.is_file():
            return f"Not a file: {path}"
        text = real.read_text(encoding="utf-8")
        if text.count(old_text) != 1:
            return f"old_text must appear exactly once in {path} (found {text.count(old_text)})."
        real.write_text(text.replace(old_text, new_text), encoding="utf-8")
        self.record("edit_file", str(real.relative_to(self.root)))
        return f"Edited {real.relative_to(self.root)}."

    def run_command(self, command: str) -> str:
        if not self.can_execute(command):
            return self.deny("execute", f"command not allowed: {command!r}")
        out = self.harness(ALLOWED_COMMANDS[command.strip()])
        return f"exit code {out.returncode}\n{out.stdout[-20_000:]}{out.stderr[-5_000:]}"

    def report_step(self, tool: str, summary: str) -> str:
        self.record(f"model:{tool}"[:60], summary)
        return "Recorded."

    def submit_draft(self, policy_id: str, summary: str) -> str:
        if policy_id != self.policy_id:
            return f"policy_id must be {self.policy_id}."
        if not (self.policies / "rules" / f"{policy_id}.json").is_file():
            return f"Write policies/rules/{policy_id}.json first."
        self.submitted = {"policyId": policy_id, "summary": summary}
        self.record("submit_draft", summary)
        return "Submitted. The desk re-runs the tests and the backtest itself before filing the draft."

    # ── Harness ────────────────────────────────────────────────────────────

    def harness(self, script: str, record: bool = True) -> subprocess.CompletedProcess:
        """Runs one of the two harness scripts with this interpreter, in the workspace, without secrets."""
        env = {k: v for k, v in os.environ.items() if k not in SECRET_ENV}
        try:
            out = subprocess.run(
                [self.python, f"harness/{script}"], cwd=self.root, env=env, capture_output=True, text=True,
                timeout=COMMAND_TIMEOUT, check=False,
            )
        except subprocess.TimeoutExpired:
            out = subprocess.CompletedProcess([script], 124, "", f"timed out after {COMMAND_TIMEOUT}s")
        if record:
            self.record("run_tests" if script == "run_tests.py" else "backtest",
                        summarize(out), "done" if out.returncode == 0 else "failed")
        return out

    def harness_result(self, script: str) -> dict[str, Any]:
        out = self.harness(script, record=False)
        return result_line(out.stdout) or {"ok": False, "errors": [out.stderr[-500:] or "no RESULT line"]}


def result_line(stdout: str) -> dict[str, Any] | None:
    for line in reversed(stdout.splitlines()):
        if line.startswith("RESULT "):
            try:
                return json.loads(line[len("RESULT "):])
            except ValueError:
                return None
    return None


def summarize(out: subprocess.CompletedProcess) -> str:
    lines = [ln for ln in out.stdout.splitlines() if not ln.startswith("RESULT ")]
    tail = lines[-1] if lines else out.stderr.strip()[-200:]
    return f"exit {out.returncode}: {tail}"
