# Access Desk

Autonomous credit and access desk for a multi-product financial platform. It reads from systems of record, proposes work, asks humans when needed, and writes back only through one gateway, with every step logged.

## Layout

```
spacetime/   SpacetimeDB module: system of work (golden records, work items, state machine, roles, audit log)
server/      Node service
  gateway/     only writer to systems of record (authorize + execute)
  sync/        change-only pulls from sources (billing, Nessie bank feed)
  agents/      credit analyst and access controller (Claude)
  simulator/   simulated systems of record (billing, ledger, admin console)
  domain/      products, restriction ladder, gateway action schemas
web/         React + Vite UI (work queue, controller, client portal, audit log)
```

## Setup

Requires Node 22+, pnpm, and the [SpacetimeDB CLI](https://spacetimedb.com/install).

```bash
pnpm install
cp .env.example .env        # add API keys
pnpm stdb:start             # terminal 1: local SpacetimeDB
pnpm stdb:publish           # publish the module
pnpm stdb:generate          # regenerate client bindings after schema changes
pnpm dev                    # server on :4000, web on :5173
```

`pnpm typecheck` checks all packages.
