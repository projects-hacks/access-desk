import anthropic
from anthropic import beta_tool

from .prompt import CLAUDE_TOOLS, build_prompt
from .sandbox import Sandbox


def claude_tools(sandbox: Sandbox) -> list:
    """The same tools the Droid gets, implemented on the sandbox so the checks are identical."""

    def read_file(path: str) -> str:
        """Read a text file in the workspace.

        Args:
            path: Path relative to the workspace, e.g. data/task.json.
        """
        return sandbox.read_file(path)

    def list_dir(path: str = ".") -> str:
        """List a directory in the workspace.

        Args:
            path: Directory relative to the workspace.
        """
        return sandbox.list_dir(path)

    def search(pattern: str, path: str = ".") -> str:
        """Search files in the workspace for a regular expression; returns file:line: text.

        Args:
            pattern: Python regular expression.
            path: File or directory relative to the workspace.
        """
        return sandbox.search(pattern, path)

    def write_file(path: str, content: str) -> str:
        """Create or overwrite a file. Only paths under policies/ are allowed.

        Args:
            path: e.g. policies/rules/pol-014.json or policies/cases/PRC-0001.json.
            content: Full file contents.
        """
        return sandbox.write_file(path, content)

    def edit_file(path: str, old_text: str, new_text: str) -> str:
        """Replace one exact occurrence of old_text in a file under policies/.

        Args:
            path: File under policies/.
            old_text: Text that appears exactly once in the file.
            new_text: Replacement text.
        """
        return sandbox.edit_file(path, old_text, new_text)

    def run_command(command: str) -> str:
        """Run a harness command. Only `python harness/run_tests.py` and `python harness/backtest.py` are allowed.

        Args:
            command: The exact command.
        """
        return sandbox.run_command(command)

    def report_step(tool: str, summary: str) -> str:
        """Record a step of your work (plan, findings, backtest summary) for the audit log.

        Args:
            tool: Short label, e.g. plan or backtest.
            summary: One or two sentences.
        """
        return sandbox.report_step(tool, summary)

    def submit_draft(policy_id: str, summary: str) -> str:
        """Hand the finished draft back to the desk. Call once, after the tests pass and the backtest has run.

        Args:
            policy_id: The policy id from data/task.json.
            summary: Two sentences for the controller.
        """
        return sandbox.submit_draft(policy_id, summary)

    return [beta_tool(f) for f in (read_file, list_dir, search, write_file, edit_file, run_command, report_step,
                                   submit_draft)]


def run_claude(sandbox: Sandbox, task: dict, *, client: anthropic.Anthropic, model: str, max_turns: int) -> bool:
    """The fallback runner: Claude through the SDK's tool runner, with the sandbox's tools. True on a clean finish."""
    runner = client.beta.messages.tool_runner(
        model=model,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        tools=claude_tools(sandbox),
        max_iterations=max_turns,
        messages=[{"role": "user", "content": build_prompt(task, CLAUDE_TOOLS)}],
    )
    last = None
    for message in runner:
        last = message.stop_reason
        if last == "refusal":
            sandbox.record("claude", "Claude declined to continue", "failed")
            return False
        if last == "max_tokens":
            sandbox.record("claude", "a reply hit max_tokens", "failed")
            return False
        for block in message.content:
            if block.type == "text" and block.text.strip():
                sandbox.record("claude:note", block.text.strip())
    if last not in ("end_turn", "tool_use", "stop_sequence"):
        sandbox.record("claude", f"run ended: {last}", "failed")
        return False
    return True
