# Agents

Four agents, each a Factory Droid with one job, and no orchestrator. The database decides which agent runs, for which client, and when: the reducer that changes something queues the task in the same transaction, and the agents' subscription receives it in the push for that commit.

| Agent | Name on the panel | Job | Code |
|---|---|---|---|
| `learning` | Iris | Keeps each client's credit profile current (reliability, value, coverage, expected settle date); records whether the client's own policies are passing | `agents/src/agents/learning.ts`, `agents/src/credit/` |
| `scoring` | Quinn | Turns the profile into a tier; proposes tier changes or a client policy (Droid decides within guardrails, rules as fallback) | `agents/src/agents/scoring.ts`, `agents/src/credit/` |
| `exploit` | Rowan | Flags clients gaming the payment terms (six patterns, sudden changes, book consistency) | `agents/src/agents/exploit.ts`, `agents/src/exploit/` |
| `access` | Sage | Holds, restricts, debits and restores, one step at a time and only as far as the contract allows; notices and RM replies | `agents/src/agents/access.ts`, `agents/src/access/` |

## How an agent is woken

```
event (wire, ACH return, deadline, withdrawal, RM note, approval…)
  → reducer, one transaction: rows changed · rules checked · agent_task queued (ROUTES) · episode step · audit
  → pushed to the agents' subscription → dispatcher claims the task → agent.handle(one client)
  → agent writes through reducers (same guardrails as people) → those reducers queue the next agent
```

Routing lives in one table, `ROUTES` in `spacetime/src/agents.ts`:

| Change | Wakes |
|---|---|
| New client, cash in, payment returned, dispute, a person rejected an agent's proposal, new sim day (clients with something overdue) | learning |
| Credit profile moved, a client's own policy started failing | scoring |
| Cash in, payment returned, dispute, deadline, withdrawal | exploit |
| Cash in, payment returned, deadline, RM note, tier changed, exploit flag, restriction live at the platform, a person decided on an access item, new sim day | access |

- **One open task per agent and client**: a second change before the agent runs folds into the queued task.
- **Claim, complete, fail** (`spacetime/src/reducers/agents.ts`): only queued tasks can be claimed, only the claimer finishes; a failure goes back to the queue up to 3 attempts. A running task with no word for 180 s is requeued by the scheduled tick (agents heartbeat every 60 s during long Droid calls).
- **Dispatcher** (`agents/src/dispatcher.ts`): up to 4 tasks per agent at once, never two for the same client; the four agents run independently.

## What the panel shows

`episode` and `episode_step` are written by the database in the transaction that does the work: audit rows worth showing become steps (`stepFromAudit`), the proposal reducers add the guardrails each action passed, a refused agent action becomes a guardrail step (`record_guardrail`), and the gateway adds what the platform or bank now shows. Text is in words before it is stored: names, not ids; "Mar 14", not ISO dates; no policy or pattern codes (`humanize`).

## Measured (Maincloud, 2026-10-24)

| | |
|---|---|
| Change, rule checks, task, step and audit | one transaction, same commit timestamp |
| Reducer call → committed → pushed back to a subscriber | median ≈ 100 ms, min 76 ms, p90 330 ms (n = 18, mostly network) |
| Withdrawal request → decided → wired through Nessie | 1.08 s; request step → "sent from custody" step 548 ms by the database clock |
| Droid decision (Scoring) | ≈ 11 s |

## Try and run

```bash
pnpm agents:try access ORG-90355     # what Access would do for one client; no writes
pnpm --filter @access-desk/agents test
pnpm agents                          # the hosted process only (AGENTS_HOST=true)
```
