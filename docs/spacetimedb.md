# Why SpacetimeDB

The database is the application. Business rules live in reducers inside the database, every commit is pushed to every screen and agent, and timed work is a scheduled reducer. One shared database on Maincloud, no local copies.

| Piece | Role | Code |
|---|---|---|
| Reducers | All business logic: payment checking, work-item state machine, deadlines, tie-out | `spacetime/src/reducers/`, `spacetime/src/payments/`, `spacetime/src/books/` |
| Subscriptions | Push every commit to the web UI, the gateway and the server | `web/src/lib/bank.ts`, `server/src/gateway/executor.ts` |
| Agent dispatch | Reducers queue `agent_task` rows in the same transaction as the change; the agents get them pushed ([agents](agents.md)) | `spacetime/src/agents.ts`, `agents/src/dispatcher.ts` |
| Scheduled reducer | `tick_clock` every second: moves the sim clock, requeues stuck gateway commands and agent tasks | `spacetime/src/reducers/world.ts` |
| Views | `my_*` views keyed on `ctx.sender` give each client only its own rows | `spacetime/src/reducers/portal.ts` |

## One transaction, end to end

Follow one wire that cures a client in default.

1. A Nessie deposit appears. Sync calls `upsert_cash_movement` (role SYNC) in `spacetime/src/reducers/sync.ts`.
2. The same reducer calls `onCashMovement` (`spacetime/src/reducers/payments.ts`). In that one transaction it:
   - resolves the payer (account, wallet, name or quoted reference);
   - plans the match and applies it to invoices (`applyPlan`, `spacetime/src/payments/apply.ts`);
   - queues the receipt and application journals and an `APPLY_PAYMENT` command (`spacetime/src/payments/gateway.ts`, idempotent by `key`);
   - queues `RELEASE_HOLD` and closes cure periods if the client is no longer in default (`releaseHoldsIfCured`);
   - queues a task for each agent that should look (`ROUTES`);
   - writes `audit_event` rows.
3. The commit is pushed to every subscribed screen and agent. Nothing polls.
4. The gateway sees the new `gateway_command` rows, calls `claim_gateway_command`, writes the platform or Nessie, then `complete_gateway_command`, which writes the platform's resulting state back in another transaction ([money](money.md#the-gateway)).

If any step throws, none of it commits: there is no state with the cash recorded but the invoice unapplied. Measured: 0.66 s from sync to hold released.

## Why not Postgres

| Need | Postgres | Here |
|---|---|---|
| Business logic | Application server calling the database | Reducers run in the database; one call is one transaction |
| Real-time | LISTEN/NOTIFY, a message bus or a websocket layer | Subscriptions on the tables themselves, with filters |
| Many actors | 4 agents, sync, gateway and the console each need an API and auth | Each connects with its own identity and calls reducers directly |
| Permissions | Checked in the API, outside the transaction | `requireRole` and separation of duties inside the reducer that changes the row |
| Timed work | Cron service plus a job queue | Scheduled reducer `tick_clock` |
| Audit | Triggers or application logging | `audit()` in the same reducer as the change; denials are audited too |

With Postgres this is a database, an API server, a message bus, a cron service and a websocket layer kept consistent. Here it is one system.

What that buys:

- **Atomic money.** Payment checking, hold release and journal queueing commit with the cash row.
- **A transactional outbox from table rows.** Gateway commands are claimed (only `queued` can be, so no double execution), completed, or failed with retry (5 attempts) in `spacetime/src/reducers/gateway.ts`. Commands stuck 60 s in `executing` go back to the queue.
- **Separation of duties in the write path** (`spacetime/src/reducers/work.ts`): legal transitions only, approvers are ACCOUNTANT or CONTROLLER, no self-approval, only the gateway posts. A denied attempt returns instead of throwing, so its audit row commits.
- **Contract time is data.** Cure periods are `deadline` rows resolved when the sim date moves (`spacetime/src/payments/deadlines.ts`).
- **Agents and clients face the same checks as people.** `place_order` checks trading permission and cash in the transaction and commits a refusal with its reason.
- **No orchestrator.** The reducer that changes a row queues the agent that cares, so routing is deterministic, durable and visible as rows.

**Client portal privacy.** The Client view opens its own connection as a separate identity (`web/src/lib/portal.ts`) and subscribes only to ten views: `my_client`, `my_invoices`, `my_holdings`, `my_levers`, `my_permissions`, `my_holds`, `my_access_requests`, `my_bank_accounts`, `my_notices`, `my_orders`. Each looks up the caller in `actor` and returns only that client's rows; an unbound identity gets nothing. `bind_portal` (DEMO or ADMIN only) refuses any identity that holds a staff or service role. `pnpm portal:verify` checks it live.

## Honest limits

- Staff tables are public on the module (`{ public: true }` in `spacetime/src/tables/`) because the console, sync, gateway and agents read them directly; role checks guard writes. The portal reads only through the views, but a client opening a raw connection could still query base tables. Closing that needs private tables with staff-side views, or row-level filters (deprecated in 2.13).
- An agent's own work dominates its reaction time: dispatch is about 0.15 to 0.2 s (push plus claim), a model decision about 11 s. A routing gap would leave an agent asleep, so the daily wake covers clients with anything overdue.
- The shared database runs on the Maincloud free tier.

## The schema in brief

46 tables plus the `my_*` views, in `spacetime/src/tables/` (one file per area). Conventions: `*_cents` is i64 integer cents, never floats; `*_on` is `'YYYY-MM-DD'` in the simulated world, compared against `clock.sim_date`; `*_at` is a real timestamp; `*_json` is a JSON string; ids are stable text from the source (`ORG-90412`, `INV-1021`). Derived values (aging, unpaid totals, exposure) are not stored. Every state change appends to `audit_event` in the same reducer. Fields the system owns (client status and tier, lever state, match status, paid amounts) come from sync on first import only. Names on the wire are snake_case; the generated bindings expose camelCase.

| Area | Tables | What they hold |
|---|---|---|
| World and sync | `platform`, `clock`, `actor`, `sync_source`, `raw_record` | Platform settings; the sim date; identity and role; status and source payload of each sync |
| Clients and access | `client`, `payer_identity`, `contract`, `contract_clause`, `capability`, `access_lever`, `permission` | Clients with tier and status; known accounts, wallets, affiliates; terms and signed clauses; what each lever can do; lever state; console permissions |
| Money | `invoice`, `dispute`, `cash_movement`, `payment_application`, `client_credit`, `ledger_entry`, `bank_account` | Invoices and paid amounts; disputes; every bank and chain movement with `match_status`; cash applied to invoices; credits and unapplied cash; GL lines; statement balances |
| Assets | `custody_holding`, `asset_price`, `hold`, `owed_to_client`, `position`, `loan`, `trade_order` | Custody balances; holds on overdue amounts; netting; hedged positions; credit lines; orders |
| Work | `work_item`, `decision`, `investigation_step`, `rm_note`, `notice`, `gateway_command`, `access_request`, `deadline`, `agent_run` | Proposals and their state machine; who decided; RM notes; notices; the gateway outbox; withdrawal decisions; cure periods, promises, return-by dates |
| Agents | `agent_task`, `episode`, `episode_step` | The queue that wakes agents; what happened to a client; the steps the panel shows, with guardrail checks |
| Learning | `credit_profile`, `policy`, `precedent`, `metric_snapshot`, `exploit_flag` | Scores; baseline and client policies by version and status (`draft`, `active`, `superseded`, `rejected`); past decisions; the weekly trend; flags and evidence |
| Audit and books | `audit_event`, `tie_out_run`, `tie_out_break` | Every state change with actor, role and policy; each tie-out and its breaks |

## Connect

Database `access-desk-calhacks13` on `maincloud.spacetimedb.com`. Dashboard: https://spacetimedb.com/access-desk-calhacks13 (tables, logs, SQL; owner's login). Only one process writes bank data: sync, run by the owner. Nobody else needs a Nessie key. Defaults in `.env.example` already point at the shared database: copy it to `.env`.

| From | How |
|---|---|
| Web | Bindings in `web/src/module_bindings`, defaults in `web/src/lib/config.ts` |
| Server | `connectStdb()` in `server/src/lib/stdb.ts` (reconnects with backoff). Check: `pnpm --filter @access-desk/server stdb:check` |
| Agents | `connect()` in `agents/src/db.ts`: one connection, the whole database subscribed; writes go through `ctx.attempt(...)` |
| Terminal | `pnpm stdb:sql "SELECT * FROM work_item"`, `pnpm stdb:logs` (needs the `spacetime` CLI) |

**Identity and roles.** Every reducer checks the caller's role (`actor` table; `spacetime/src/roles.ts`). Roles: ADMIN, SYNC, GATEWAY, DEMO, AGENT, ACCOUNTANT, RELATIONSHIP_MANAGER, CONTROLLER, CLIENT, VIEWER. Only ADMIN (the publisher) grants them.

1. Get an identity: `curl -X POST https://maincloud.spacetimedb.com/v1/identity`, which returns `identity` and `token`.
2. The owner runs `spacetime call -s maincloud access-desk-calhacks13 assign_role '"<identity>"' '"<name>"' '"<ROLE>"' null`.
3. Save the token in `.env`: `STDB_TOKEN` (SYNC), `STDB_GATEWAY_TOKEN` (GATEWAY), `STDB_DEMO_TOKEN` (DEMO, also the living platform), `STDB_AGENT_TOKEN` (AGENT), `VITE_STDB_CONTROLLER_TOKEN` (the console's controller). After a database reset, `pnpm stdb:roles` re-assigns them. Tokens live in `.env`, never in git.

**Changing the schema (owner only).** Edit `spacetime/src`, then `pnpm stdb:publish`. On a breaking change, `pnpm stdb:publish:reset` **wipes all data** (sync refills it). Then `pnpm stdb:generate` and commit the regenerated `module_bindings` folders.
