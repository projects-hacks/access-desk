# Access Desk

Autonomous credit and access desk for a multi-product financial platform. It reads from systems of record, proposes work, asks humans when needed, and writes back only through one gateway, with every step logged.

## Layout

```
spacetime/   SpacetimeDB module (TypeScript): tables, work-item state machine, roles, audit log
server/      Node service (TypeScript)
  gateway/     only writer to systems of record (authorize + execute)
  sync/        change-only pulls from sources (billing, Nessie bank feed)
  simulator/   simulated systems of record (billing, ledger, admin console)
  domain/      products, restriction ladder, gateway action schemas
agents/      Python: credit analyst and access controller (Claude, Factory Droid SDK)
web/         React + Vite UI (work queue, controller, client portal, audit log)
```

SpacetimeDB holds all state and enforces the rules. `server/`, `agents/` and `web/` are its clients: the web app subscribes over WebSocket, the server handles anything that touches external systems, and agents read via SQL and propose work by calling reducers over HTTP.

## Setup

Requires Node 22+, pnpm, Python 3.11+ with [uv](https://docs.astral.sh/uv/), the [SpacetimeDB CLI](https://spacetimedb.com/install), and the `droid` CLI for agents.

```bash
pnpm install
(cd agents && uv sync)
cp .env.example .env        # add API keys
pnpm stdb:start             # terminal 1: local SpacetimeDB
pnpm stdb:publish           # publish the module
pnpm stdb:generate          # regenerate TS bindings after schema changes
pnpm dev                    # server on :4000, web on :5173
pnpm agents                 # agents loop
```

`pnpm typecheck` checks the TypeScript packages; `cd agents && uv run ruff check` lints Python.
