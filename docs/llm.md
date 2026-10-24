# Choosing the LLM

The credit analyst asks a language model to decide each client's tier. Which model answers is a
setting, not a rewrite: Factory's `droid-sdk` by default (running `claude-opus-5-5`), with the Claude API as the backup. A provider is
only a function that takes the conversation and returns text. Everything that makes the answer
safe stays in our Python code and is the same for every provider.

## Why pluggable

- We are not locked to one vendor, price or outage.
- We can compare providers on the same history before trusting one (see "The gate").
- Switching back is one setting.

## Settings

| Setting | Meaning |
|---|---|
| `LLM_PROVIDER` | `factory` (default) or `anthropic` |
| `LLM_FALLBACK` | provider to try if the first fails or is unavailable; default `anthropic`; empty means none |
| `FACTORY_MODEL` | the model Droid should use; default `claude-opus-5-5`, the one the gate was run on |
| `FACTORY_TIMEOUT_SECONDS` / `FACTORY_ATTEMPTS` | 120 s per try; 2 tries, each in a fresh session |
| `FACTORY_API_KEY` | Factory key; without it `factory` is unavailable |

The Claude settings (`ANTHROPIC_API_KEY`, model) are unchanged.

## How Droid is locked down

Droid is an agent that can normally run tools and edit files. We use it as a plain
question-and-answer box:

- lowest autonomy level;
- no tools enabled;
- every permission request is automatically rejected;
- it runs in a throwaway empty folder, deleted afterwards.

Whatever it returns is only text. Python then validates every answer exactly as for Claude: the
JSON schema, then every guardrail (tier range, step limits, citations that exist, policy
rules). One retry with the problems listed, then the rules decide. The model never touches the
books or the ledger.

## The fallback chain

provider, then fallback, then rules. If the chosen provider has no key, times out, refuses or
breaks the guardrails twice, the next one is tried; if none works the deterministic rules decide
(same as running with no key). Each decision records who made it (`decided_by`, `provider`,
`model`), and the console shows it: "Decided by Factory (model)", "Decided by Claude
(Anthropic)", "Decided by rules".

## Switching and rolling back

Factory is the default. It needs the `droid` CLI on the PATH and `FACTORY_API_KEY`; without them
the Claude API answers instead, so nobody has to install anything to run the agents. To roll back,
set `LLM_PROVIDER=anthropic` and restart. Past decisions keep the provider they were made
with.

## The gate

Before switching, score the provider on the real history (a replay of past month-ends; makes
live calls and costs money):

```
cd agents
uv run python -m desk_agents.credit eval-provider anthropic
uv run python -m desk_agents.credit eval-provider factory --price-in 1 --price-out 5 --json factory.json
# options: --cutoffs 2025-09-30,2025-10-31  --books tests/fixtures/book.json
```

Exit codes: 0 gate passed, 1 gate failed, 2 provider not available (no key or `droid` missing).

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
session; the rerun passed.

**Known limits.** Still about one call in 36 comes back unusable and falls to the next provider; the
slowest call took 115 s; the sample is smaller than the 5-month Claude backtest (6 differences
against 17), so rerun the gate with all cutoffs before relying on it for more than the demo. The
default Droid model (`gpt-6-sol`) was not gated and gave a connection error once; stay on
`claude-opus-5-5` unless you gate another.

**Lockdown, tested live.** Asked to write a file and run a command, the session did neither.
