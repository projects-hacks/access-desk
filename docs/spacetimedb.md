# Why SpacetimeDB

The database is the application. Business rules live in reducers inside the database, every commit is pushed to every screen and agent, and timed work is a scheduled reducer. Hosted on Maincloud ([database](database.md)).

## What runs where

```
Nessie bank ──┐
              ├─► sync ─► reducers (SpacetimeDB module) ─► subscribers ─► gateway ─► platform / Nessie
simulated     │            tables, roles, audit, tick_clock   web UI (2 controller seats, agents panel)
platform ─────┘            agent_task (who runs next)         4 agents on Azure (woken by agent_task)
                                                             gateway (claims commands)
```

| Piece | Role | Code |
|---|---|---|
| Reducers | All business logic: payment checking, work-item state machine, deadlines, tie-out | `spacetime/src/reducers/`, `spacetime/src/payments/`, `spacetime/src/books/` |
| Subscriptions | Push every commit to the web UI, the gateway and the server | `web/src/lib/bank.ts`, `server/src/gateway/executor.ts` |
| Agent dispatch | Reducers queue `agent_task` rows in the same transaction as the change; the agents get them pushed ([agents.md](agents.md)) | `spacetime/src/agents.ts`, `agents/src/dispatcher.ts` |
| Scheduled reducer | `tick_clock` every second: moves the sim clock, requeues stuck commands and stuck agent tasks | `spacetime/src/reducers/world.ts`, `spacetime/src/tables/world.ts` |

## One transaction, end to end

Follow one wire that cures a client in default.

1. A Nessie deposit appears. Sync calls `upsert_cash_movement` (role SYNC) in `spacetime/src/reducers/sync.ts`.
2. The same reducer calls `onCashMovement` (`spacetime/src/reducers/payments.ts`). In that one transaction it:
   - resolves the payer (account, wallet, name or quoted reference);
   - plans the match and applies it to invoices (`applyPlan`, `spacetime/src/payments/apply.ts`);
   - queues the receipt and application journals and an `APPLY_PAYMENT` command (`spacetime/src/payments/gateway.ts`, idempotent by `key`);
   - queues `RELEASE_HOLD` and closes cure periods if the client is no longer in default (`releaseHoldsIfCured`);
   - writes `audit_event` rows (`audit` in `spacetime/src/context.ts`).
3. The commit is pushed to every subscribed screen and agent. Nothing polls.
4. The gateway sees the new `gateway_command` rows, calls `claim_gateway_command`, writes the platform or Nessie, then `complete_gateway_command`, which writes the platform's resulting state back in another transaction (`docs/books.md`).

If any step throws, none of it commits: there is no state with the cash recorded but the invoice unapplied.

Measured: 0.66 s from sync to hold released (`docs/payments.md`). Tie-out compares bank, invoices and unapplied cash to the general ledger in integer cents; any difference not explained by queued journals is `unexplained`, logged as a `BOOKS_BREAK` and shown as a red alert on every screen (`spacetime/src/books/tieout.ts`, `web/src/components/AlertBar.tsx`).

## Why not Postgres

| Need | Postgres | Here |
|---|---|---|
| Business logic | Application server calling the database | Reducers run in the database; one call is one transaction (`upsert_cash_movement`) |
| Real-time | Add LISTEN/NOTIFY, a message bus or a websocket layer | Subscriptions on the tables themselves, with filters |
| Many actors | 3 hosted agents, sync, gateway and 2 controller seats each need an API and auth | Each connects with its own identity and calls reducers directly |
| Permissions | Checked in the API, outside the transaction | `requireRole` and separation of duties inside the reducer that changes the row |
| Timed work | cron service plus a job queue | Scheduled reducer `tick_clock`; stuck commands requeued by the same tick |
| Audit | Triggers or application logging | `audit()` called in the same reducer as the change; denials are audited too |

With Postgres this is a database, an API server, a message bus, a cron service and a websocket layer kept consistent; here it is one system.

## What is novel

- Payment checking, hold release and journal queueing commit atomically with the cash row.
- The gateway is a transactional outbox built from table rows: `gateway_command` rows are claimed (only `queued` can be claimed, so no double execution), completed or failed with retry (5 attempts) in `spacetime/src/reducers/gateway.ts`; abandoned commands (60 s in `executing`) go back to the queue by the scheduled tick.
- Separation of duties in `spacetime/src/reducers/work.ts`: legal transitions only, approvers are ACCOUNTANT or CONTROLLER, controller-only items, `no self-approval`, only the gateway posts. A denied attempt returns instead of throwing, so its audit row commits.
- Contract time is data: cure periods are `deadline` rows resolved when the sim date moves (`spacetime/src/payments/deadlines.ts`).
- Agents act through the same reducers as people, so their proposals face the same checks (`docs/actions.md`). Clients too: `place_order` checks trading permission and cash in the transaction, and a refusal commits with its reason.
- No orchestrator: the reducer that changes a row queues the agent that cares about it (`ROUTES`), so routing is deterministic, durable and visible as rows.

## SpacetimeDB features we use

| Feature | Where |
|---|---|
| Reducers | `spacetime/src/reducers/*.ts` (sync, payments, work, gateway, actions, world) |
| Subscriptions with filters | `web/src/lib/bank.ts`: `tables.cashMovement.where((r) => r.isHistory.eq(false))` keeps history out of the browser |
| Scheduled reducers | `tick_clock` driven by the `clock_tick` table (`ScheduleAt.interval`), `spacetime/src/reducers/world.ts` |
| Identities and roles | `actor` table, `requireRole`, `assign_role`; role sets in `spacetime/src/roles.ts`; each service has its own token |
| Views for per-client privacy | `my_*` views keyed on `ctx.sender`, `spacetime/src/reducers/portal.ts`; the Client view's own connection, `web/src/lib/portal.ts` |
| Automatic reconnect with session resumption | `server/src/lib/stdb.ts`: `withAutomaticReconnect()`, backoff 1 s to 30 s |
| Generated TypeScript bindings | `pnpm stdb:generate` writes `web/src/module_bindings` and `server/src/module_bindings` |

## Client portal privacy

The Client view opens its own connection as a separate identity (`web/src/lib/portal.ts`) and subscribes only to nine views: `my_client`, `my_invoices`, `my_holdings`, `my_levers`, `my_permissions`, `my_holds`, `my_access_requests`, `my_bank_accounts`, `my_notices` (`spacetime/src/reducers/portal.ts`). Each view looks up the caller (`ctx.sender`) in `actor` and returns only that client's rows; an unbound identity gets nothing. The database computes the rows per identity, so other clients' data never reaches the browser.

`bind_portal` (DEMO or ADMIN only) binds a browser identity to a client; it refuses any identity that already holds a staff or service role. `pnpm portal:verify` checks it live: bound to one client the connection sees only that client, rebinding switches cleanly, a stranger sees zero rows, staff identities can't be rebound.

## Honest limits

- Staff tables are public on the module (`{ public: true }` in `spacetime/src/tables/`) because the console, sync, gateway and agents read them directly; role checks guard writes. The client portal reads only through the per-identity views; a client opening its own raw connection could still query base tables. Closing that needs private tables with staff-side views, or row-level filters (deprecated in 2.13).
- An agent's own work dominates its reaction time: dispatch is about 0.15–0.2 s (push plus claim), a Droid decision about 11 s. A routing gap would leave an agent asleep; the daily wake covers clients with anything overdue.
- The shared database runs on the Maincloud free tier.
