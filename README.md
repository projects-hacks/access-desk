# Access Desk

Autonomous credit and access desk for a multi-product financial platform. It reads the platform's systems of record, matches cash, decides what needs a person, and writes back only through one gateway, with every step logged.

```
spacetime/   SpacetimeDB module: tables, payment checking, state machine, roles, gateway outbox, tie-out, audit
server/      sync, gateway, simulated platform (billing, GL, admin, custody), Nessie bank, demo endpoints
agents/      Python agents (read via SQL, propose via reducers)
web/         React + Vite
```

## Run

Node 22+, pnpm, Python 3.11+ with uv, `spacetime` CLI (schema changes only).

```bash
pnpm install && (cd agents && uv sync)
cp .env.example .env     # points to the shared Maincloud database
pnpm dev                 # server :4000 (sync + gateway), web :5173
```

## Commands

| Command | |
|---|---|
| `pnpm sync` | One full sync pass, gateway drains, tie-out |
| `pnpm demo:reset` | Bank and database back to Tue 2026-03-03 |
| `pnpm sync:verify` · `payments:verify` · `ledger:verify` · `tieout:verify` | Check the database against sources and the answer key |
| `pnpm bank show [ORG-xxxxx]` · `bank settle WI-5531` · `bank reset` | Nessie |
| `pnpm seed:nessie [--apply]` | Seed the bank (dry run by default) |
| `pnpm stdb:publish` · `stdb:generate` · `stdb:roles` | Module and bindings |
| `pnpm typecheck` · `pnpm test` | Checks |

With `DEMO_CONTROLS=true` the server exposes `POST /demo/inject`, `/demo/settle`, `/demo/advance`, `/demo/reset` and `GET /demo/state`.

## Policy drafter (Factory Droid)

`agents/src/desk_agents/policy_drafter/`. When at least `POLICY_DRAFT_THRESHOLD` (default 4) overrides of one policy family pile up that no draft covers yet, the agent drafts a policy change. pol-003 and pol-006 count as one family, the restriction ladder (`FAMILIES` in `families.py`). An override is a precedent whose decision differs from the proposed restriction, or one that was `Rejected`. In the demo, PRC-0001..0003 plus the live Kestrel rejection produce pol-014: near renewal, hold only the amount owed. The agent only drafts. It saves the policy with status `draft` (`upsert_policy`) and files a `POLICY_DRAFT` work item for a controller. The proposal carries the rule before and after, a diff, the precedent ids, the test results and the backtest. If the controller rejects it with a note, the agent drafts once more with the note added; a second rejection stops drafting for that family.

The drafts are built to work with `applyPolicyDraft` → `activatePolicyDraft` on `aryan`:

- The proposal JSON carries `policy_key` (`pol-014@<version>`), the key of the `draft` row saved with `upsert_policy`. On approval, that row becomes active and the previous active version is superseded. On rejection, it is marked `rejected`.
- A revision or a later draft is always saved as the next version (one past every version seen), so the agent never overwrites a rejected or active row.
- Draft policy ids are platform-wide and contain no `:`. A `<base>:<client_id>` id means a company-specific policy.
- The `POLICY_DRAFT` item uses `client_id=""`.
- Credit precedents (pol-020..022) are in no family, so they never trigger a draft.

**Where it runs.** Each run gets a fresh temp directory, never the repo:

- `policies/`: the only writable area. It holds `rules/<policy_id>.json` and one `cases/<precedent_id>.json` per precedent.
- `harness/`: `run_tests.py` and `backtest.py`, read-only.
- `data/`: a read-only snapshot taken when the run starts. It contains the precedents, the clients, 12 months of invoices and payments, and today's policies.

The Droid (`droid-sdk`) runs a local `droid exec` process with this directory as its working directory. **The Droid process itself talks to Factory's API (that is where the model runs), but none of its tools have network access.** Built-in tools are limited to `Read`, `LS`, `Grep`, `Glob`, `Create`, `Edit`, `ApplyPatch` and `Execute`, so `WebSearch` and `FetchUrl` are not available. The session runs at autonomy `off`, so every edit and command asks the agent's permission handler first. The handler allows:

- creating, editing or patching a file whose resolved real path is inside `<workspace>/policies/`; `..` and symlinks are resolved before the check, and deletes are refused;
- running exactly `python harness/run_tests.py` or `python harness/backtest.py`; extra arguments, `;`, `&&` or pipes are refused;
- the agent's own in-process MCP tools, `report_step` and `submit_draft`.

The handler cancels everything else. A request that has no handler, or whose handler raises, is cancelled too. Each denial is logged as a warning on the `desk_agents.policy_drafter` logger and recorded as an investigation step with status `denied`. The steps are written with `record_investigation`. Until that reducer is published, they stay in the proposal JSON.

**Why it's sandboxed this way.** The SDK has no sandbox setting, so the agent enforces the sandbox itself, and the model can't make its own tests pass. The harness derives each case's facts from `data/` and checks every expected value against the recorded decision. Unknown or invented cases fail. After `submit_draft`, Python re-runs both scripts itself and files the draft only if every case passes. The model's report of its own tests is never trusted. Secrets (`ANTHROPIC_API_KEY`, `STDB_*`, `NESSIE_API_KEY`) are blanked in the Droid's environment.

Two limits remain. Read-only tools and commands that Factory's own policy allows (such as `ls` or `pwd`) run without asking, so the Droid can read files outside the workspace. Built-in tool ids are taken from Factory's docs, not checked against a live `droid` CLI.

**Fallback.** If the `droid` CLI is missing, `FACTORY_API_KEY` is empty, or the Droid run fails, the same prompt runs through Claude (the Anthropic SDK tool runner, `ANTHROPIC_MODEL`). The tools and permission checks are the same code (`sandbox.py`). If neither runner is available, the agent logs once that drafting is unavailable and does nothing.

**Install the Droid:**

```bash
curl -fsSL https://app.factory.ai/cli | sh   # puts `droid` on PATH
echo 'FACTORY_API_KEY=fk-...' >> .env         # from app.factory.ai settings
```

Optional settings: `DROID_EXECUTABLE`, `DROID_MODEL`, `POLICY_DRAFT_TIMEOUT_SECONDS` (900), `POLICY_DRAFT_PAID_WITHIN_DAYS` (5, used for "wrongly restricted" in the backtest).

## Docs

[database](docs/database.md) · [schema](docs/schema.md) · [sync](docs/sync.md) · [payment checking](docs/payments.md) · [agent actions](docs/actions.md) · [gateway, ledger, tie-out](docs/books.md) · [history](docs/history.md) · [bank (Nessie)](docs/bank.md)
