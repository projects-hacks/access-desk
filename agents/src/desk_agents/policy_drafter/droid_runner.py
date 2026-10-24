import json
import os
import shutil
from collections.abc import Callable
from pathlib import Path

from droid_sdk import (
    ApplyPatchAction,
    Autonomy,
    CreateFile,
    EditAction,
    ErrorEvent,
    ExecuteAction,
    InteractionHandlers,
    McpToolAction,
    PermissionAction,
    PermissionRequest,
    PermissionResponse,
    Runtime,
    Session,
    SessionConfig,
    ToolCall,
    ToolConfirmationOutcome,
)

from .prompt import DROID_TOOLS, build_prompt
from .sandbox import SECRET_ENV, Sandbox

SERVER_NAME = "policy-drafter"
MCP_TOOLS = ("report_step", "submit_draft")
# Droid's built-in tool ids for reading, listing, searching, file changes and the shell. Web tools
# (WebSearch, FetchUrl) and everything else are left out.
BUILTIN_TOOLS = ("Read", "LS", "Grep", "Glob", "Create", "Edit", "ApplyPatch", "Execute")


def droid_available(executable: str, api_key: str | None) -> str | None:
    """Why the Droid can't run here, or None if it can."""
    if not shutil.which(executable):
        return f"the droid CLI ({executable}) is not installed"
    if not (api_key or os.environ.get("FACTORY_API_KEY")):
        return "FACTORY_API_KEY is not set"
    return None


def check_action(sandbox: Sandbox, action: PermissionAction) -> tuple[bool, str, str]:
    """(allowed, tool, detail) for one action in a permission request."""
    if isinstance(action, (CreateFile, EditAction)):
        tool = "create" if isinstance(action, CreateFile) else "edit"
        return sandbox.can_write(action.file_path), tool, action.file_path
    if isinstance(action, ApplyPatchAction):
        paths = [action.file_path] if action.file_path else []
        for f in action.files or ():
            if f.operation == "delete":
                return False, "apply_patch", f"delete {f.file_path}"
            paths += [f.file_path] + ([f.move_to] if f.move_to else [])
        return bool(paths) and all(sandbox.can_write(p) for p in paths), "apply_patch", ", ".join(paths)
    if isinstance(action, ExecuteAction):
        return sandbox.can_execute(action.full_command), "execute", action.full_command
    if isinstance(action, McpToolAction):
        name = action.actual_tool_name or action.tool_name
        ours = action.server_name == SERVER_NAME and name in MCP_TOOLS
        return ours, "mcp", f"{action.server_name}/{name}"
    return False, getattr(action.confirmation_type, "value", "unknown"), type(action).__name__


def permission_handler(sandbox: Sandbox) -> Callable[[PermissionRequest], PermissionResponse]:
    """
    Allows writes under policies/, the two harness commands and our own MCP tools; cancels the rest.
    Every denial is logged and recorded as an investigation step.
    """

    def on_permission(request: PermissionRequest) -> PermissionResponse:
        verdicts = [check_action(sandbox, action) for action in request.actions]
        offered = {option.value for option in request.options}
        if verdicts and all(ok for ok, _, _ in verdicts) and ToolConfirmationOutcome.PROCEED_ONCE in offered:
            for _, tool, detail in verdicts:
                sandbox.record(tool, f"allowed: {detail}")
            return request.respond(ToolConfirmationOutcome.PROCEED_ONCE)
        for ok, tool, detail in verdicts or [(False, "unknown", "empty permission request")]:
            if not ok:
                sandbox.deny(tool, detail)
        return request.respond(ToolConfirmationOutcome.CANCEL)

    return on_permission


def mcp_server(sandbox: Sandbox):
    from droid_sdk.mcp import create_sdk_mcp_server, tool

    def report_step(tool: str, summary: str) -> str:
        return sandbox.report_step(tool, summary)

    def submit_draft(policy_id: str, summary: str) -> str:
        return sandbox.submit_draft(policy_id, summary)

    return create_sdk_mcp_server(SERVER_NAME, [
        tool("report_step", "Record a step of your work (plan, findings, backtest summary) for the audit log.",
             report_step),
        tool("submit_draft", "Hand the finished draft back to the desk. Call once, after the tests pass and the "
             "backtest has run.", submit_draft),
    ])


async def run_droid(sandbox: Sandbox, task: dict, *, executable: str, api_key: str | None, model: str | None,
                    timeout: float, bin_dir: Path) -> bool:
    """One Droid session in the workspace. True when it finished without an error."""
    config = SessionConfig(autonomy=Autonomy.OFF, mcp_servers=[mcp_server(sandbox)], restrict_tools=BUILTIN_TOOLS)
    env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}", **{k: "" for k in SECRET_ENV}}
    runtime = Runtime(executable=shutil.which(executable) or executable, env=env)
    session = Session(cwd=sandbox.root, model=model, config=config, runtime=runtime, api_key=api_key,
                      interactions=InteractionHandlers(on_permission=permission_handler(sandbox)))
    async with session:
        async with session.stream(build_prompt(task, DROID_TOOLS), timeout=timeout) as stream:
            async for event in stream:
                if isinstance(event, ToolCall):
                    sandbox.record(f"droid:{event.name}", json.dumps(dict(event.input), default=str)[:200])
                elif isinstance(event, ErrorEvent):
                    sandbox.record("droid:error", event.message, "failed")
        result = stream.result
    if not result.success:
        sandbox.record("droid", f"run ended: {result.subtype}", "failed")
    return bool(result.success)
