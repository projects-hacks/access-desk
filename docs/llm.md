# Choosing the LLM

The credit analyst asks a language model to decide each client's tier. Which model answers is a
setting, not a rewrite: today the Claude API, optionally Factory's `droid-sdk`. A provider is
only a function that takes the conversation and returns text. Everything that makes the answer
safe stays in our Python code and is the same for every provider.

## Why pluggable

- We are not locked to one vendor, price or outage.
- We can compare providers on the same history before trusting one (see "The gate").
- Switching back is one setting.

## Settings

| Setting | Meaning |
|---|---|
| `LLM_PROVIDER` | `anthropic` (default) or `factory` |
| `LLM_FALLBACK` | provider to try if the first fails or is unavailable (e.g. `anthropic`); empty means none |
| `FACTORY_MODEL` | the model Droid should use |
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

Set `LLM_PROVIDER=factory` (and `FACTORY_API_KEY`, `FACTORY_MODEL`), restart the agents. To roll
back, set `LLM_PROVIDER=anthropic` and restart. Past decisions keep the provider they were made
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

## Still to do live (not yet done)

1. Install the `droid` CLI.
2. Set `FACTORY_API_KEY`.
3. Run the Phase 0 hello-world (one trivial question through the provider, no tools).
4. Run the gate for `factory` and compare with `anthropic`.
5. Only if it passes, set `LLM_PROVIDER=factory`.
