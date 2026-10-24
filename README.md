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
cp .env.example .env     # points to the shared Maincloud database
pnpm dev                 # server :4000 (sync + gateway), web :5173
```

## Commands

| Command | |
|---|---|
| `pnpm sync` | One full sync pass, gateway drains, tie-out |
| `pnpm demo:reset` | Bank and database back to Tue 2026-03-03 |
| `pnpm sync:verify` · `payments:verify` · `ledger:verify` · `tieout:verify` | Check the database against sources and the answer key |
| `pnpm bank show [ORG-xxxxx]` · `bank settle WI-5531` · `bank reset` | Nessie |
| `pnpm seed:nessie [--apply]` | Seed the bank (dry run by default) |
| `pnpm stdb:publish` · `stdb:generate` · `stdb:roles` | Module and bindings |
| `pnpm typecheck` · `pnpm test` | Checks |

With `DEMO_CONTROLS=true` the server exposes `POST /demo/inject`, `/demo/settle`, `/demo/advance`, `/demo/reset` and `GET /demo/state`.
