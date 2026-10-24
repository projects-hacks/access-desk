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

Requires Node 22+, pnpm, and Python 3.11+ with [uv](https://docs.astral.sh/uv/).

```bash
pnpm install
(cd agents && uv sync)
cp .env.example .env        # already points to the shared database
pnpm dev                    # server on :4000, web on :5173
pnpm agents                 # agents loop
```

- Shared database (SpacetimeDB on Maincloud): [docs/database.md](docs/database.md)
- Tables, owners and conventions: [docs/schema.md](docs/schema.md)
- Bank (Nessie): seeding, demo controls, conventions: [docs/bank.md](docs/bank.md)

`pnpm typecheck` and `pnpm test` check the TypeScript packages; `cd agents && uv run ruff check` lints Python.
