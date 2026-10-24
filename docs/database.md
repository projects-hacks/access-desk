# Shared database (SpacetimeDB on Maincloud)

There is one database for the whole team, with no local copies.

- Name: `access-desk-calhacks13`
- Host: `maincloud.spacetimedb.com` (WebSocket `wss://`, HTTP `https://`)
- Dashboard: https://spacetimedb.com/access-desk-calhacks13 (tables, logs, SQL; owner's login)

Only one process writes bank data: sync, run by the owner. Everyone else just connects and reads, or calls reducers. Nobody else needs a Nessie key.

## Connect

| From | How |
|---|---|
| Web (React) | Generated bindings in `web/src/module_bindings`, with `VITE_STDB_URI` / `VITE_STDB_DATABASE` from `.env` |
| Server (TS) | `connectStdb()` in `server/src/lib/stdb.ts`. Check it with `pnpm --filter @access-desk/server stdb:check` |
| Agents (Python) | `SpacetimeClient` in `agents/src/desk_agents/stdb.py`, over HTTP: `sql(...)` returns typed rows (options → `None`, timestamps → `datetime`, identities → hex); `call(...)` raises `ReducerError` when a reducer refuses; `propose(Proposal)` creates a work item |
| Terminal | `pnpm stdb:sql "SELECT * FROM work_item"`, `pnpm stdb:logs` (needs the `spacetime` CLI) |

Defaults in `.env.example` already point to the shared database. Copy it to `.env` and you're connected.

**Identity and roles:** every reducer checks the caller's role (`actor` table). Roles: ADMIN, SYNC, GATEWAY, AGENT, ACCOUNTANT, RELATIONSHIP_MANAGER, CONTROLLER, CLIENT, VIEWER. Only ADMIN (the publisher) grants them.

1. Get an identity: `curl -X POST https://maincloud.spacetimedb.com/v1/identity`, which returns `identity` and `token`.
2. Ask Rajeev to run `spacetime call -s maincloud access-desk-calhacks13 assign_role '"<identity>"' '"<name>"' '"<ROLE>"' null`.
3. Save the token: `STDB_TOKEN` (server, role SYNC) or `STDB_AGENT_TOKEN` (agents, role AGENT). The shared tokens are in the team's `.env`, never in git.

**Names on the wire:** tables, columns and reducers are snake_case (`work_item`, `amount_cents`, `propose_work_item`). Generated TS bindings expose them in camelCase.

## Changing the schema (owner only)

1. Edit `spacetime/src`.
2. Run `pnpm stdb:publish`. If it reports a breaking change, run `pnpm stdb:publish:reset`, which **wipes all data** (sync refills bank data; tell the team first).
3. Run `pnpm stdb:generate` and commit the regenerated `module_bindings` folders.
