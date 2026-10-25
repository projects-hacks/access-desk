# Choosing the LLM

The scoring agent asks a language model to decide each client's tier (the exploit agent uses the same `ask`). Factory's Droid (`@factory/droid-sdk`, running `claude-opus-5-5`) answers first, with the Claude API (`@anthropic-ai/sdk`) as the backup. A provider is
only a function that takes a prompt and returns text. Everything that makes the answer
safe stays in our TypeScript code and is the same for every provider.

Code: `agents/src/llm/` (`index.ts` `makeAsk` / `askWith`, `droid.ts`, `claude.ts`, `errors.ts`). Agents get it as `ctx.ask`.

## Why pluggable

- We are not locked to one vendor, price or outage.
- A provider that is missing or fails hands the call to the next.

## Settings

| Setting | Meaning |
|---|---|
| `FACTORY_API_KEY` | Factory key; Droid is used only with this and a `droid` executable on PATH |
| `ANTHROPIC_API_KEY` | Claude key; the backup is used only with this |
| `LLM_MODEL` | the model for both; default `claude-opus-5-5`, the one Droid was gated on |

Fixed in code: Droid 120 s per session, 2 sessions (each fresh); Claude 45 s, 8000 tokens, effort low, 1 SDK retry. The order (Droid, then Claude) is not configurable. The old `LLM_PROVIDER`, `LLM_FALLBACK` and `FACTORY_*` settings no longer exist.

## How Droid is locked down

Droid is an agent that can normally run tools and edit files. We use it as a plain
question-and-answer box:

- autonomy off, low reasoning effort, builtin skills off;
- every tool the session offers is disabled (the TS SDK has no "restrict to none", so `droid.ts` lists the tools and disables them all);
- every permission request is automatically rejected;
- it runs in a throwaway empty folder, deleted afterwards;
- structured output (a JSON schema) is requested.

Whatever it returns is only text. `askWith` parses it (a code fence is stripped) and hands it to the caller's `validate`: the JSON shape, then every guardrail (tier range, step limits, citations that exist, policy
rules). A rejection is asked again once with the problems listed, then `AnswerRejected` and the rules decide. The model never touches the
books or the ledger. `validate` also gets `{provider, model}` as a second argument, which is how a proposal records who decided.

The Claude schema must be strict-compatible (every property required, `additionalProperties: false`, no min/max).

## The fallback chain

Droid, then Claude, then rules. A provider that is not set up is skipped. One that times out, errors or comes back cut short hands the call to the next (Droid retries once in a fresh session first). If none answers, `ask` throws `DecisionUnavailable`; an answer rejected twice throws `AnswerRejected` (a subclass). The caller then uses the deterministic rules (same as running with no key). Each decision records who made it (`decided_by`, `provider`, `model`), and the console shows it: "Decided by Factory (model)", "Decided by Claude
(Anthropic)", "Decided by rules".

## Setting up and rolling back

Droid needs the `droid` CLI on PATH (the hosted image installs it with `curl -fsSL https://app.factory.ai/cli | sh`) and `FACTORY_API_KEY`; without them
the Claude API answers instead, so nobody has to install anything to run the agents. To skip Droid, unset `FACTORY_API_KEY` and restart. Past decisions keep the provider they were made
with.

Tests: `pnpm --filter @access-desk/agents test` (`agents/src/llm/llm.test.ts`: the chain, the retry note, rejection, fakes only; no live calls). To try one decision on the shared database without writing: `pnpm agents:try scoring <clientId>`.

## The gate (not ported)

The Python `eval-provider` command (a replay of past month-ends that scored a provider; live calls, cost money) was not ported, and neither was the backtest. The checks below are how Factory was gated before the port; to gate another provider or model, that tooling has to be rebuilt.

| Check | Pass mark |
|---|---|
| Answers valid within two tries | at least 95% |
| Right when it differs from the rules | at least 12 of 17 (scaled to at least 70% if the total differs) |
| Repeatability: same decisions on 3 runs of one cutoff | at least 90% |
| Full cycle | at most 90 s |
| Cost | reported only (`unknown` unless prices are given; Claude defaults to $4 / $20 per million tokens) |

## Gate result (Factory, `claude-opus-5-5`, run live)

Two month-ends (2025-10-31 and 2025-12-31) plus a three-run repeat of 2025-12-31, 87 calls,
`droid` 0.249.0, six calls at a time:

| Check | Result | Pass mark |
|---|---|---|
| Valid within two tries | 35 of 36 (97%) | 95% |
| Right when it differs from the rules | 6 of 6 | 5 of 6 |
| Repeatability | 16 of 17 (94%) | 90% |
| Full cycle | 38.5 s | 90 s |
| Cost | unknown (Factory reports tokens, not price): 136k in / 45k out | reported only |

**What the first run taught us.** The first run failed two checks (92% valid, 82% repeatable)
because, with six Droid processes at once, some timed out at 60 s or came back cut short. The same
clients answered correctly alone. The adapter now allows 120 s and retries once in a fresh
session (the TypeScript `droid.ts` keeps the same limits); the rerun passed.

**Known limits.** Still about one call in 36 comes back unusable and falls to the next provider; the
slowest call took 115 s; the sample is smaller than the 5-month Claude backtest (6 differences
against 17), so rerun the gate with all cutoffs before relying on it for more than the demo. The
default Droid model (`gpt-6-sol`) was not gated and gave a connection error once; stay on
`claude-opus-5-5` unless you gate another.

**Lockdown, tested live.** Asked to write a file and run a command, the session did neither.
