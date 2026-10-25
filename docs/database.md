# Shared database (SpacetimeDB on Maincloud)

There is one shared database, with no local copies.

- Name: `access-desk-calhacks13`
- Host: `maincloud.spacetimedb.com` (WebSocket `wss://`, HTTP `https://`)
- Dashboard: https://spacetimedb.com/access-desk-calhacks13 (tables, logs, SQL; owner's login)

Only one process writes bank data: sync, run by the owner. Everyone else just connects and reads, or calls reducers. Nobody else needs a Nessie key.

## Connect

| From | How |
|---|---|
| Web (React) | Generated bindings in `web/src/module_bindings`, Maincloud defaults in `web/src/lib/config.ts` |
| Server (TS) | `connectStdb()` in `server/src/lib/stdb.ts`. Check it with `pnpm --filter @access-desk/server stdb:check` |
| Agents (TS) | `connect()` in `agents/src/db.ts`: one connection, the whole database subscribed; agents read the live cache and write through `ctx.attempt(...)` (a refused reducer is recorded on the agents panel). See [agents.md](agents.md) |
| Terminal | `pnpm stdb:sql "SELECT * FROM work_item"`, `pnpm stdb:logs` (needs the `spacetime` CLI) |

Defaults in `.env.example` already point to the shared database. Copy it to `.env` and you're connected.

**Identity and roles:** every reducer checks the caller's role (`actor` table). Roles: ADMIN, SYNC, GATEWAY, DEMO, AGENT, ACCOUNTANT, RELATIONSHIP_MANAGER, CONTROLLER, CLIENT, VIEWER. Only ADMIN (the publisher) grants them.

1. Get an identity: `curl -X POST https://maincloud.spacetimedb.com/v1/identity`, which returns `identity` and `token`.
2. The database owner runs `spacetime call -s maincloud access-desk-calhacks13 assign_role '"<identity>"' '"<name>"' '"<ROLE>"' null`.
3. Save the token in `.env`: `STDB_TOKEN` (sync, role SYNC), `STDB_GATEWAY_TOKEN` (gateway, role GATEWAY), `STDB_DEMO_TOKEN` (demo controls, role DEMO), `STDB_AGENT_TOKEN` (agents, role AGENT), `VITE_STDB_CONTROLLER_TOKEN` and `VITE_STDB_CONTROLLER_B_TOKEN` (web console seats Controller A and B, role CONTROLLER). After a database reset, `pnpm stdb:roles` re-assigns them. Tokens live in `.env`, never in git.

**Names on the wire:** tables, columns and reducers are snake_case (`work_item`, `amount_cents`, `propose_work_item`). Generated TS bindings expose them in camelCase.

## Changing the schema (owner only)

1. Edit `spacetime/src`.
2. Run `pnpm stdb:publish`. If it reports a breaking change, run `pnpm stdb:publish:reset`, which **wipes all data** (sync refills it).
3. Run `pnpm stdb:generate` and commit the regenerated `module_bindings` folders.
