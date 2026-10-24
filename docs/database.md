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
| Agents (Python) | `SpacetimeClient` in `agents/src/desk_agents/stdb.py`, over HTTP: `sql(...)` to read, `call(reducer, *args)` to write |
| Terminal | `pnpm stdb:sql "SELECT * FROM work_item"`, `pnpm stdb:logs` (needs the `spacetime` CLI) |

Defaults in `.env.example` already point to the shared database. Copy it to `.env` and you're connected.

**Identity:** each service should keep one identity so its role sticks. Get a token once with `curl -X POST https://maincloud.spacetimedb.com/v1/identity`, then save it as `STDB_TOKEN` (server) or `STDB_AGENT_TOKEN` (agents). Without a token, every HTTP call is a new anonymous identity.

**Names on the wire:** tables, columns and reducers are snake_case (`work_item`, `amount_cents`, `propose_work_item`). Generated TS bindings expose them in camelCase.

## Changing the schema (owner only)

1. Edit `spacetime/src`.
2. Run `pnpm stdb:publish`. If it reports a breaking change, run `pnpm stdb:publish:reset`, which **wipes all data** (sync refills bank data; tell the team first).
3. Run `pnpm stdb:generate` and commit the regenerated `module_bindings` folders.
