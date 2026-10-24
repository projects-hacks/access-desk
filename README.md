# Access Desk

Autonomous credit and access desk for a multi-product financial platform. It reads the platform's systems of record, matches cash, decides what needs a person, and writes back only through one gateway, with every step logged.

```
spacetime/   SpacetimeDB module: tables, payment checking, state machine, roles, gateway outbox, tie-out, audit
server/      sync, gateway, simulated platform (billing, GL, admin, custody), Nessie bank, demo endpoints
agents/      Python agents (read via SQL, propose via reducers)
web/         React + Vite
```

## Run

Node 22+, pnpm, Python 3.11+ with uv, `spacetime` CLI (schema changes only).

```bash
pnpm install && (cd agents && uv sync)
cp .env.example .env     # shared Maincloud database + hosted API (ask for the values)
pnpm dev                 # web :5173, talking to the hosted API
```

The API server (sync, gateway, simulated platform, demo endpoints) runs once, on Azure Container Apps, because it is the only writer to the shared database. Every push to `main` is checked (typecheck, tests) and, if green, built and deployed there by CI. Don't run a second server against the shared database: `pnpm dev:server` refuses to start unless you mean it (stop the hosted one first with `pnpm host:stop`).

## Commands

| Command | |
|---|---|
| `pnpm demo:reset` | Bank, database and the hosted server back to Tue 2026-03-03 |
| `pnpm demo:rebuild` | After a schema change: republish with a data reset, roles, restart the hosted server |
| `pnpm host:restart` · `host:stop` · `host:start` | The hosted server (needs `az` access) |
| `pnpm sync` · `pnpm actions:verify` | Run their own gateway: only with the hosted server stopped |
| `pnpm sync:verify` · `payments:verify` · `ledger:verify` · `tieout:verify` | Check the database against sources and the answer key |
| `pnpm bank show [ORG-xxxxx]` · `bank settle WI-5531` · `bank reset` | Nessie |
| `pnpm seed:nessie [--apply]` | Seed the bank (dry run by default) |
| `pnpm stdb:publish` · `stdb:generate` · `stdb:roles` | Module and bindings |
| `pnpm credit:verify` · `credit:fixture` | Seat 1 output against the answer key · rebuild its test fixture |
| `pnpm typecheck` · `pnpm test` | Checks |

The hosted server exposes `POST /demo/inject`, `/demo/settle`, `/demo/advance`, `/demo/clock`, `/demo/withdraw`, `/demo/reset` (header `x-demo-key`) and `GET /demo/state`.

## Docs

[database](docs/database.md) · [schema](docs/schema.md) · [sync](docs/sync.md) · [payment checking](docs/payments.md) · [agent actions](docs/actions.md) · [gateway, ledger, tie-out](docs/books.md) · [history](docs/history.md) · [bank (Nessie)](docs/bank.md) · [credit analyst](docs/credit.md) · [exploit watch](docs/exploits.md)
