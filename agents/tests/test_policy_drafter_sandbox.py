import asyncio
import os
import tempfile
import unittest
from types import SimpleNamespace
from typing import ClassVar
from unittest import mock

from droid_sdk import (
    ApplyPatchAction,
    ApplyPatchFile,
    Autonomy,
    CreateFile,
    EditAction,
    ErrorEvent,
    ErrorType,
    ExecuteAction,
    McpToolAction,
    PermissionOption,
    PermissionRequest,
    SandboxOperation,
    SandboxViolationAction,
    SandboxViolationType,
    ToolCall,
    ToolConfirmationOutcome,
    ToolUseBlock,
)
from policy_drafter_fakes import workspace

from desk_agents.policy_drafter import droid_runner
from desk_agents.policy_drafter.droid_runner import BUILTIN_TOOLS, SERVER_NAME, permission_handler

ALLOW, CANCEL = ToolConfirmationOutcome.PROCEED_ONCE, ToolConfirmationOutcome.CANCEL
USE = ToolUseBlock(id="toolu_1", name="tool", input={})


def request(*actions, options=(ALLOW, CANCEL)):
    return PermissionRequest(actions=actions, options=[PermissionOption(label=o.value, value=o) for o in options])


def create(path):
    return CreateFile(tool_use=USE, file_path=path, file_name=os.path.basename(path), content="{}")


def execute(command):
    return ExecuteAction(tool_use=USE, full_command=command, command=command)


class PermissionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws, self.sandbox, _ = workspace(self.tmp.name)
        self.handler = permission_handler(self.sandbox)
        self.root = str(self.sandbox.root)

    def tearDown(self):
        self.ws.remove()
        self.tmp.cleanup()

    def decide(self, *actions, **kw):
        return self.handler(request(*actions, **kw)).selected_option

    def assertDenied(self, *actions):
        before = len(self.sandbox.steps)
        with self.assertLogs("desk_agents.policy_drafter", "WARNING") as logs:
            self.assertEqual(self.decide(*actions), CANCEL)
        self.assertIn("denied", logs.output[0])
        self.assertEqual(self.sandbox.steps[-1].status, "denied")
        self.assertGreater(len(self.sandbox.steps), before)

    def test_writes_under_policies_are_allowed(self):
        self.assertEqual(self.decide(create("policies/rules/pol-014.json")), ALLOW)
        self.assertEqual(self.decide(create(f"{self.root}/policies/cases/PRC-0001.json")), ALLOW)
        self.assertEqual(self.decide(EditAction(tool_use=USE, file_path="policies/rules/pol-014.json",
                                                file_name="pol-014.json")), ALLOW)
        patch = ApplyPatchAction(tool_use=USE, file_path="policies/rules/pol-014.json", file_name="pol-014.json",
                                 patch_content="...", files=[ApplyPatchFile(file_path="policies/cases/PRC-0002.json",
                                                                            file_name="PRC-0002.json",
                                                                            operation="create")])
        self.assertEqual(self.decide(patch), ALLOW)

    def test_writes_elsewhere_are_denied(self):
        for path in ("harness/run_tests.py", "data/task.json", "policies", "../escape.json", "/etc/passwd",
                     f"{self.root}/../outside.json", "~/.ssh/config"):
            with self.subTest(path=path):
                self.assertDenied(create(path))

    def test_dot_dot_out_of_policies_is_denied(self):
        self.assertDenied(create("policies/../harness/run_tests.py"))
        self.assertDenied(create("policies/rules/../../data/task.json"))

    def test_symlinks_out_of_policies_are_denied(self):
        outside = os.path.join(self.tmp.name, "outside.json")
        os.symlink(outside, os.path.join(self.root, "policies/rules/evil.json"))
        os.symlink(os.path.join(self.root, "data"), os.path.join(self.root, "policies/cases/data"))
        self.assertDenied(create("policies/rules/evil.json"))
        self.assertDenied(create("policies/cases/data/task.json"))

    def test_patch_touching_any_outside_path_is_denied(self):
        patch = ApplyPatchAction(tool_use=USE, file_path="policies/rules/pol-014.json", file_name="pol-014.json",
                                 patch_content="...", files=[ApplyPatchFile(file_path="harness/backtest.py",
                                                                            file_name="backtest.py",
                                                                            operation="update")])
        self.assertDenied(patch)
        delete = ApplyPatchAction(tool_use=USE, file_path="policies/rules/pol-014.json", file_name="pol-014.json",
                                  patch_content="...", files=[ApplyPatchFile(file_path="policies/rules/pol-014.json",
                                                                             file_name="pol-014.json",
                                                                             operation="delete")])
        self.assertDenied(delete)

    def test_only_the_two_exact_commands_run(self):
        self.assertEqual(self.decide(execute("python harness/run_tests.py")), ALLOW)
        self.assertEqual(self.decide(execute("python harness/backtest.py")), ALLOW)
        for command in ("python harness/run_tests.py --verbose", "python harness/run_tests.py; rm -rf policies",
                        "python harness/run_tests.py && curl http://example.com", "python3 harness/run_tests.py",
                        "python harness/run_tests.py | tee policies/x", "python harness/run_tests.py\nls",
                        "ls", "cat data/task.json", "python -c 'import os'"):
            with self.subTest(command=command):
                self.assertDenied(execute(command))

    def test_only_our_mcp_tools_are_allowed(self):
        ours = McpToolAction(tool_use=USE, tool_name="submit_draft", impact_level="low", server_name=SERVER_NAME,
                             actual_tool_name="submit_draft")
        self.assertEqual(self.decide(ours), ALLOW)
        self.assertDenied(McpToolAction(tool_use=USE, tool_name="fetch", impact_level="low", server_name="web",
                                        actual_tool_name="fetch"))
        self.assertDenied(McpToolAction(tool_use=USE, tool_name="delete_all", impact_level="high",
                                        server_name=SERVER_NAME, actual_tool_name="delete_all"))

    def test_unknown_actions_are_denied(self):
        violation = SandboxViolationAction(tool_use=USE, violating_tool_name="FetchUrl", target="https://example.com",
                                           operation=SandboxOperation.NETWORK,
                                           violation_type=SandboxViolationType.NETWORK, reason="network",
                                           is_org_deny=False)
        self.assertDenied(violation)

    def test_one_bad_action_cancels_the_whole_request(self):
        self.assertDenied(create("policies/rules/pol-014.json"), execute("rm -rf /"))

    def test_cancel_when_proceed_is_not_offered(self):
        self.assertEqual(self.decide(create("policies/rules/pol-014.json"), options=(CANCEL,)), CANCEL)

    def test_restricted_builtin_tools_have_no_web_tools(self):
        self.assertFalse({"WebSearch", "FetchUrl"} & set(BUILTIN_TOOLS))


class SandboxToolsTest(unittest.TestCase):
    """The Claude runner's tools go through the same checks."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws, self.sandbox, _ = workspace(self.tmp.name)

    def tearDown(self):
        self.ws.remove()
        self.tmp.cleanup()

    def test_file_tools(self):
        self.assertIn("Wrote", self.sandbox.write_file("policies/rules/pol-014.json", '{"a": 1}'))
        self.assertIn("Edited", self.sandbox.edit_file("policies/rules/pol-014.json", '"a": 1', '"a": 2'))
        self.assertEqual(self.sandbox.read_file("policies/rules/pol-014.json"), '{"a": 2}')
        with self.assertLogs("desk_agents.policy_drafter", "WARNING"):
            self.assertIn("Denied", self.sandbox.write_file("data/task.json", "{}"))
            self.assertIn("Denied", self.sandbox.read_file("../../../../etc/hosts"))
            self.assertIn("Denied", self.sandbox.run_command("python harness/run_tests.py; ls"))
        self.assertIn("task.json", self.sandbox.list_dir("data"))
        self.assertIn("PRC-0001", self.sandbox.search("PRC-0001", "data"))

    def test_read_only_areas_are_read_only_on_disk_too(self):
        with self.assertRaises(PermissionError):
            (self.sandbox.root / "data" / "task.json").write_text("{}")


class FakeStream:
    def __init__(self, events):
        self.events, self.result = events, SimpleNamespace(success=True, subtype="success")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for event in self.events:
            yield event


class FakeSession:
    instances: ClassVar[list["FakeSession"]] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        FakeSession.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def stream(self, prompt, timeout=None):
        self.prompt, self.timeout = prompt, timeout
        return FakeStream([ToolCall(name="Read", tool_use_id="t1", input={"file_path": "data/task.json"}),
                           ErrorEvent(message="Permission interaction handler failed",
                                      error_type=ErrorType.DROID_CLIENT_ERROR)])


class DroidSessionTest(unittest.TestCase):
    """The Droid session is configured as the README says. No droid CLI is started."""

    def test_session_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws, sandbox, data = workspace(tmp)
            try:
                with mock.patch.object(droid_runner, "Session", FakeSession):
                    ok = asyncio.run(droid_runner.run_droid(sandbox, data["task"], executable="droid",
                                                            api_key="fk-test", model=None, timeout=60,
                                                            bin_dir=ws.bin))
                session = FakeSession.instances[-1]
                config, runtime = session.kwargs["config"], session.kwargs["runtime"]
                self.assertTrue(ok)
                self.assertEqual(session.kwargs["cwd"], sandbox.root)
                self.assertEqual(config.restrict_tools, frozenset(BUILTIN_TOOLS))
                self.assertEqual(config.autonomy, Autonomy.OFF)
                (server,) = config.mcp_servers
                self.assertEqual((server.name, [t.name for t in server.tools]),
                                 (SERVER_NAME, ["report_step", "submit_draft"]))
                self.assertTrue(runtime.env["PATH"].startswith(str(ws.bin)))
                self.assertEqual(runtime.env["ANTHROPIC_API_KEY"], "")
                self.assertIsNotNone(session.kwargs["interactions"].on_permission)
                self.assertIn("python harness/run_tests.py", session.prompt)
                self.assertEqual([s.tool for s in sandbox.steps], ["droid:Read", "droid:error"])
                self.assertTrue((ws.bin / "python").exists())
            finally:
                ws.remove()


if __name__ == "__main__":
    unittest.main()
