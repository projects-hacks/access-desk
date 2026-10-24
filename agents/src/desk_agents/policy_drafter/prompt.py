from typing import Any

SANDBOX_RULES = """\
Sandbox rules (enforced; anything else is denied and logged):
- Your working directory is the workspace. Only files under policies/ may be created or edited.
- harness/ and data/ are read-only. Never try to change them or work around them.
- The only commands you may run are exactly `python harness/run_tests.py` and `python harness/backtest.py`,
  with no arguments, pipes or other commands chained.
- There is no network access. Do not fetch or search the web."""

STEPS = """\
Work in this order:
1. Read data/task.json and the precedents it lists in data/precedents.json, plus harness/run_tests.py,
   whose docstring defines the rule format (match / effect keys) the harness evaluates.
   Call report_step with tool "plan" and a short plan.
2. Write one case file per precedent in task.json's overrides and controls:
   policies/cases/<precedentId>.json = {{"precedentId": "<id>", "expected": "<that precedent's decision, verbatim>"}}.
   The harness derives each case's facts from data/ and rejects unknown ids or a wrong `expected`, so copy
   the decision exactly. Do not invent cases.
3. Write the rule to policies/rules/{policy_id}.json with policyId "{policy_id}", a short title, English
   `when` and `then`, and machine-checkable `match` and `effect`. The overrides must come out as the person
   decided and the controls must stay unchanged. Prefer the narrowest rule that explains the overrides.
4. Run `python harness/run_tests.py`. Fix the rule (never the cases' expectations) until every case passes.
5. Run `python harness/backtest.py` over the 12 months of history and read its summary and assumptions.
6. Call report_step with tool "backtest" summarising cases changed, money impact and clients wrongly
   restricted, then call submit_draft with policy_id "{policy_id}" and a two-sentence summary for the
   controller. Stop after submit_draft."""


def build_prompt(task: dict[str, Any], tools_note: str) -> str:
    overrides = ", ".join(task["overrides"])
    controls = ", ".join(task["controls"]) or "none"
    revision = ""
    if task.get("rejectionNote"):
        revision = (
            f"\nThis is revision {task['revision']}. A controller rejected revision {task['revision'] - 1} "
            f"(work item {task['revisedFrom']}) with this note:\n\"{task['rejectionNote']}\"\n"
            f"The rejected rule was:\n{task.get('previousRule')}\nAddress the note in the new rule.\n"
        )
    return f"""\
You draft a policy change for an autonomous credit and access desk at a crypto prime broker. People keep
overriding the {task['family'].replace('_', ' ')} policy ({', '.join(task['policyRefs'])}) the same way.
Draft policy {task['policyId']} version {task['version']} so the desk proposes what people actually decide.
You only draft: a controller reviews and activates it.

Overrides to explain: {overrides}.
Confirmed decisions the draft must not change (controls): {controls}.
{revision}
{SANDBOX_RULES}

{tools_note}

{STEPS.format(policy_id=task['policyId'])}
"""


DROID_TOOLS = """\
Tools: use your read, list and search tools to inspect files, your create/edit tools for files under
policies/, your execute tool for the two harness commands, and the MCP tools report_step and submit_draft."""

CLAUDE_TOOLS = """\
Tools: read_file, list_dir and search inspect the workspace; write_file and edit_file change files under
policies/; run_command runs the two harness commands; report_step logs a step; submit_draft hands the draft
back. Paths are relative to the workspace."""
