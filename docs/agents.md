# Agents

Four agents, no orchestrator. The database decides which agent runs, for which client, and when: the reducer that changes something queues the task in the same transaction, and the agents' subscription gets it in the push for that commit. Agents act through the same reducers as people, so the guardrails live in the database, not in the agents.

| Agent | Panel name | Job | Code |
|---|---|---|---|
| `learning` | Iris | Keeps each client's credit profile current, checks the client's own policies against real payments, looks after the books. Rules only, no model | `agents/src/agents/learning.ts`, `agents/src/credit/`, `agents/src/books/` |
| `scoring` | Quinn | Turns the profile into a tier. Proposes tier changes or a client policy. The model decides inside guardrails, rules as fallback | `agents/src/agents/scoring.ts`, `agents/src/credit/` |
| `exploit` | Rowan | Flags clients gaming the payment terms, books that disagree with themselves, sudden changes. Flags only | `agents/src/agents/exploit.ts`, `agents/src/exploit/` |
| `access` | Sage | Holds, restricts, debits and restores, one step at a time and only as far as the contract allows. Notices and RM replies | `agents/src/agents/access.ts`, `agents/src/access/` |

## What wakes them

Routing is one table, `ROUTES` in `spacetime/src/agents.ts`. The reducer that handles the event queues the task.

| Change | Wakes |
|---|---|
| New client, cash in, payment returned, dispute, a person rejected an agent's proposal, new sim day (clients with something overdue) | Iris |
| Unidentified cash parked, or an unexplained tie-out break (a task for the books, not a client) | Iris |
| Credit profile moved, a client's own policy started failing | Quinn |
| Cash in, payment returned, dispute, deadline, withdrawal | Rowan |
| Cash in, payment returned, deadline, RM note, tier changed, exploit flag, restriction or restore live at the platform, a person decided an access item, new sim day | Sage |

## How a task runs

- **One open task per agent and client.** A second change before the agent runs folds into the queued task.
- **Claim, complete, fail** (`spacetime/src/reducers/agents.ts`). Only queued tasks can be claimed, only the claimer finishes. A failure goes back to the queue, up to 3 attempts. A task with no word for 180 s is requeued by the scheduled tick; agents heartbeat every 60 s.
- **Dispatcher** (`agents/src/dispatcher.ts`). Up to 4 tasks per agent at once, never two for the same client. A 10 s rescan covers a push missed across a reconnect.
- **Panel.** `episode` and `episode_step` are written by the database in the transaction that does the work; a refused agent action becomes a guardrail step.
- **Stale proposals.** An agent's proposal nobody decides in 10 business days is withdrawn (not rejected) and its agent decides again on today's numbers (`spacetime/src/staleness.ts`).

## Guardrails in the reducers

Each reducer checks the contract, the platform's capabilities and policy before a work item exists, and refuses with the reason otherwise. Approved actions run through the gateway ([money](money.md#the-gateway)).

| Reducer | Checks |
|---|---|
| `propose_custody_debit` | debit clause signed (§6.3), invoices overdue and undisputed, USD custody covers them |
| `propose_restriction` | lever in contract, step in `capability`, something overdue, cure period over (§9.1), set-off clause for withdrawals, no close-only on a hedged book (pol-008), no restriction while a payment from the last 5 days is still in transit |
| `propose_restore` | lever currently restricted |
| `propose_notice` | non-empty body |
| `set_deadline` | date after today |
| `request_custody_withdrawal` | caller is the client, DEMO, CONTROLLER or ADMIN. Decided at once: available = USD custody minus active holds minus withdrawals in flight |
| `propose_adjusting_journal` | see [Iris on the books](#iris-on-the-books) |

Generic proposals (credit reviews, policy drafts, novel cases) use `propose_work_item`. A restriction on withdrawals becomes a hold of the undisputed overdue amount; `FULL_FREEZE` turns withdrawals off.

**What a person must approve.** The module decides from the client in the database, so an agent cannot talk its way past it (`spacetime/src/autonomy.ts`).

| Applies at once (`auto_applied`, audited `AUTO_APPLIED`) | Waits for a controller |
|---|---|
| Restrictions (pol-006), custody debits of any amount (pol-005), restores (pol-011), notices (pol-007) | Restricting a Tier 1 or strategic client |
| Tier changes, reviews and exploit alerts for every other client | Tier changes and reviews for Tier 1 or strategic clients, and any promotion into Tier 1 |
| Reminder-only client policies | Client policies that change the contract or move money (prepay, grace or cure days, cross-default, custody debit) |
| All need confidence 0.1 or more (`MIN_AUTO_CONFIDENCE`), except exploit alerts. A model's tier move that differs from what the rules would do also needs 0.7 or more (`MIN_OVERRIDE_CONFIDENCE`) | Lower confidence, or the model going beyond the rules below 0.7. Offboarding (`two_approvers` capabilities such as close-only and full freeze, or turning off every console permission) |

`transition_work_item` enforces the rest: approvers are ACCOUNTANT or CONTROLLER, `required_role = CONTROLLER` items need a controller, nobody approves their own proposal, denied attempts are audited rather than thrown. APPROVED becomes POSTED when the gateway confirms every command. The console runs as one named controller (`VITE_STDB_CONTROLLER_TOKEN`); reads need no token.

**Contract time.** `advance_clock(days)` or `set_clock_speed` move the sim date. Each day, due deadlines resolve (a cure period becomes `expired` or `met`, a promise `broken` or `met`) and clients past grace get a default notice (pol-007) that starts the cure period. Paying what was in default closes open cure periods. A withdrawal during a cure period is honored (§9.1), but if it leaves custody below the amount in default the module raises an exploit alert (`withdrawal_during_cure`).

## Scoring (Quinn)

Scores are deterministic and are the evidence. Invoices that count: past due, not void, not disputed. dpd = max(0, paid_on minus due_on), open ones counted to today. Weight = 0.5^(age/90).

| Score (`credit_profile`) | Rule |
|---|---|
| Reliability 0-100 | 100 minus lateness (0.8 x weighted mean dpd, cap 35), frequency (20 x share with dpd > 10), severity (15 if worst dpd in 180 days > 60, 8 if > 30), paid in pieces (cap 10), disputes lost (1.5 each, cap 15); short histories pulled toward 70 |
| Value 0-100 | 75 x log of fees billed in 365 days (smallest to largest client) plus 25 x products / 4 |
| Coverage | (USD custody if the §6.3 clause is signed, plus owed to client) divided by undisputed unpaid |
| Expected settle | oldest open undisputed due date plus weighted median lag |

**Baseline tier** (used as is when no model answers). Reliability 85+ is tier 2, 70+ tier 3, 55+ tier 4, else 5; value 75+ lifts one tier; any exploit flag caps at tier 3. Strategic clients get a `review`, never a tier change (pol-022). Upgrade one step, only if reliability clears its band by 3+ and `recent_late` is quiet (pol-021). Downgrade up to two steps (pol-020). Nothing new is proposed while an item for the same view waits on a person or was rejected under 30 sim days ago.

**The model** is asked only where something is happening: the baseline proposes a change, a flag fired, or one of the client's policies is failing. It gets the facts as labelled data (scores, flags with evidence invoice ids, invoice history, contract clauses, baseline, the client's policies and precedents) and returns JSON: `action` (`stay`, `tier_change`, `review`), `to_tier`, an optional policy with terms and success criteria, `reasons`, `cited_invoice_ids`, `confidence`. Guardrails (`agents/src/credit/guardrails.ts`) reject the answer if it breaks any of these:

- tier 1 to 5, at most 2 steps worse and 1 step better; strategic clients review only; any flag caps a tier change at tier 3; `recent_late` blocks an upgrade;
- policy levers: prepay and custody debit only with an allowed clause; cross-default, grace (0-15 days) and cure (5-15 days) only as renewal terms; reminders 1-10 days before due;
- a policy has a title, 1+ terms and 1+ criteria (share 0 to 1, days 0 to 90, known pattern, window 1 to 12 months); one open draft per client;
- every cited invoice is in the client's book; a tier change or draft cites at least one.

One retry with the problems listed. A second rejection, a provider error or no model gives the baseline, recorded as `decided_by: rules`. The panel and Credit screen show who decided and the model's choice next to the baseline. Quinn starts with a reminder-only policy and proposes contract or money terms only when reminders already failed or cannot work. Approving a tier change sets `client.tier` if it is still `from_tier`; contract grace and cure stay as signed until renewal.

## Exploit checks (Rowan)

Rowan owns every `exploit_flag` row and `EXPLOIT_FLAG` item (id `<pattern>:<client_id>`). A controller's `cleared` sticks. Strategic clients get status `watch`, others `flagged`.

| Pattern | Fires when | Seen on |
|---|---|---|
| `restriction_eve` | 6+ single-payment invoices in 8 months, 85%+ paid the same day after due, past grace | Juniper |
| `partial_reset` | 2+ invoices with a first payment under 60% and the balance after the restriction day | Wrenfield |
| `pays_restricted_only` | median lag per product differs by 15+ days, the slow one past grace | Monarch |
| `quarter_end` | 1-6 payment dates in 365 days, 2+ months of invoices per date | Halcyon |
| `recent_late` | 2 of the last 3 paid months over 5 days late, mean 7+ worse than before | Kestrel, Fieldstone |
| `dispute_delay` | half the months disputed, 80% upheld, 80% paid within 3 days of the ruling | Orchard |

It also checks the data (`paid_mismatch`, `prior_overclaimed`, `invoice_overapplied`, `movement_overapplied`, `duplicate_movement`, `duplicate_payment`, `hold_exceeds_overdue`, `paid_without_date`, `paid_after_today`, `tier_mismatch`, `tie_out_break`) and sudden changes (`lateness_jump`, `first_dispute`, `new_partials`; dropped when the pattern they resemble already fired). Every finding has a severity, a measured string and evidence row ids. Rules label it: high is an alert, medium a watch. The model may relabel medium or pattern-less findings, citing only evidence ids it was given; any unknown id keeps the rules' labels. Rowan writes a flag for each alert and watch and one `EXPLOIT_FLAG` item per new alert. Findings with no client are not Rowan's: the module raises `BOOKS_BREAK` itself.

## How learning works

| What | How |
|---|---|
| Precedents | Every decision a person makes becomes a `precedent` (`PRC-L<id>`), approved or rejected, with the note as `override_reason`. The model sees the client's precedents and outcomes. 12 past decisions come from [history](money.md#history) |
| Rejections | A person rejecting an agent's proposal wakes Iris. The same view is not proposed again for 30 sim days. The panel logs "Lesson recorded from a rejection" |
| Client policies | A model draft becomes a `policy` row `pol-020:<client>@<version>` (`draft`) and a `POLICY_DRAFT` item. Agents can only save drafts. Approval (automatic for reminder-only) makes it `active` and the previous version `superseded`; rejection makes it `rejected`. In force, its terms run: each business day a reminder goes out N days before every open invoice is due (once per invoice, never to a client already in default), and prepay applies at once. Terms marked for renewal wait for it (`spacetime/src/policyTerms.ts`) |
| Success tests | Each draft carries criteria (`share_paid_within_grace`, `mean_days_late`, `max_days_late`, `pattern_not_firing`). Iris evaluates active policies on invoices due since `effective_on` (fewer than 2: `pending`) and writes the verdict with `record_policy_outcome`. A policy turning failing wakes Quinn for a better version |
| Weekly trend | Each business week the module counts `AUTO_APPLIED` against `PROPOSE` (needed a person) over the last four weeks, so one busy week does not swing it, and writes `share_needing_human` and `handled_automatically` to `metric_snapshot`, continuing from 12 weeks of history (`spacetime/src/autonomyTrend.ts`) |

## Iris on the books

Tasks with client id `books` are Iris's (`agents/src/books/`).

**Breaks.** When a tie-out leaves an unexplained difference ([money](money.md#ledger-and-tie-out)), Iris traces it to payments: a return booked to receivables twice, or cash applied whose journal never reached the ledger. She builds an adjusting entry moving the amount out of receivables (1200) and unapplied cash (2300) and calls `propose_adjusting_journal`. The reducer checks that it balances, touches only 1200 and 2300 (never cash, the bank is the truth), only areas that are off, and moves each closer to tying. It posts on its own under **pol-016** only if it closes every difference to the cent, confidence is 0.8+, it is at most $500,000, and pol-016 is active. A partial correction waits for a controller, and a break in a bank account stays with the controller. The journal's ref names the payments it corrects, so one cause is never corrected twice.

**Unidentified cash.** Money from an unknown payer is parked as unapplied cash with a return-by date 5 days out. Iris looks for an owner by sender name plus an exact amount a client owes. One strong match becomes a `PAYMENT_MATCH` proposal; several or weak matches go to a person. After the return-by date she returns bank money to the sender (`return_cash`, a `RETURN_PAYMENT` command) or keeps USDC as unclaimed cash (`keep_unclaimed`), since the bank cannot send crypto back. Before that date an agent cannot resolve it. A person can match (`claim_cash`) or return it any time from the bank feed.

## The model

Droid (`@factory/droid-sdk`) answers first, the Claude API (`@anthropic-ai/sdk`) is the backup, the rules are the fallback. Everything that makes an answer safe is our code and is the same for both. Code: `agents/src/llm/`; agents get it as `ctx.ask`. It serves Quinn's decision, Rowan's labels, and Sage's notice wording and RM-note reading.

| Setting | Meaning |
|---|---|
| `FACTORY_API_KEY` | Droid is used only with this and a `droid` executable on PATH (the hosted image installs it) |
| `ANTHROPIC_API_KEY` | The backup is used only with this |
| `LLM_MODEL` | Model for both, default `claude-opus-5-5` |
| `LLM_CONCURRENCY` | The cap on model calls in flight across all four agents, default 2. Each Droid call is its own CLI process, so this bounds memory; the rest wait |

- **Droid is locked down:** autonomy off, low reasoning effort, every tool disabled, every permission request rejected, an empty throwaway folder, JSON-schema output. 120 s per session with one fresh retry. Claude: 45 s, 8000 tokens, one SDK retry.
- **The answer is only text.** It is parsed and validated (shape, then guardrails); one retry with the problems listed, then the rules decide. Each decision records `decided_by`, provider and model.
- **No key, no `droid`, a timeout or a refusal** hands the call to the next provider, then to the rules. With no model the agents still run.

Measured on Maincloud (2026-10-24): reducer call to committed to pushed back, median about 100 ms, p90 330 ms (n = 18, mostly network); withdrawal request to decided to wired through Nessie, 1.08 s; a Droid decision (Quinn), about 11 s.

## Agents with tools

`AGENT_MODE` lets Sage and Rowan run as Droid sessions that read the database and act through MCP tools instead of answering one question. **The hosted agents run with `droid`.** The code default is `rules`, so a local run never acts unless asked.

| `AGENT_MODE` | |
|---|---|
| `rules` (default) | Rules act. No tool sessions |
| `shadow` | Rules act. A Droid agent runs beside them with action tools in record-only mode; nothing is written, both choices are logged |
| `droid` | The Droid agent acts. A timeout, error or no decision falls back to the rules |

It runs only for Sage when the rules' move is a restriction, hold, debit, restore or notice, and for Rowan when the rules would write a flag; routine tasks stay on rules. The session (`agents/src/llm/agentSession.ts`) has built-in tools off, one MCP server (`desk`) on, a 120 s timeout, and holds one of the `LLM_CONCURRENCY` slots. The tool server (`agents/src/tools/server.ts`) is loopback only and gives each session a token naming one task's toolset, so tools take no client id and see only that client. Read tools: `client_overview`, `invoices`, `payments`, `history`, `similar_cases`, plus `findings` and `pattern_checks` for Rowan. Sage acts with `hold_amount_owed`, `restrict_lever`, `collect_overdue_from_custody`, `send_notice`, `restore_lever`, `hold_off` (one succeeds per task, three refusals end it); Rowan with `flag_pattern` and never restricts. Every action goes through `ctx.attempt`, so a reducer refusal lands on the panel and goes back to the model as `refused: ...`.

## Try and test

```bash
pnpm agents:try access ORG-90355        # what Sage would do for one client; no writes
pnpm agents:try scoring <clientId>      # also asks the model if one is set up
pnpm --filter @access-desk/agents test  # rules, guardrails, retries; no live model calls
pnpm --filter @access-desk/agents shadow <access|exploit|both> [clients...] [--all] [--out file.json]
                                        # rules vs Droid agent side by side; dry run, needs droid on PATH
pnpm agents                             # the hosted process only (AGENTS_HOST=true); never beside the hosted one
pnpm demo:reset && pnpm actions:verify  # live guardrail check, then demo:reset again
pnpm credit:verify                      # profiles, flags and reviews against the answer key
pnpm -s stdb:sql "SELECT id, name, tier FROM client"   # client ids
```
