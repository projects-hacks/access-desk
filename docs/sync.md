# Sync

Sync pulls every system of record into the shared database. **Run it in one place only** (Rajeev's machine, later the deployed server); everyone else just reads the database.

```bash
pnpm dev               # server: full sync on start, bank + chain every 5s, everything every 60s
pnpm sync              # one full pass, then exit
pnpm sync:verify       # check the database against the sources (exit 1 on any mismatch)
curl -X POST localhost:4000/sync/now   # pull the bank immediately (after settling a demo wire)
```

## Sources

| Source | Feeds | From |
|---|---|---|
| `crm` | client, payer_identity, contract, contract_clause | dataset |
| `billing` | invoice, dispute | dataset |
| `platform_admin` | capability, access_lever | dataset |
| `custody` | custody_holding, asset_price, owed_to_client | dataset |
| `positions` | position, loan | dataset |
| `bank` | cash_movement | Nessie (platform's Collections and Disbursements accounts) |
| `chain` | cash_movement | dataset (USDC to the platform wallet) |

Status for each is in the `sync_source` table.

## Rules

- Only changed rows are written. Every golden row gets a `raw_record` with the source payload.
- Cash dated after `clock.sim_date` is skipped; cash that disappears from the source is removed.
- Fields our system owns (`match_status`, client status, lever state, loan borrowing, invoice paid/status) are never overwritten by a re-sync.
- Memo types are mapped explicitly. An unknown memo type, status or missing `ID` fails the pass loudly.
- On-chain transfers carry no reference (`refs` is empty); matching uses wallet and amount.

## Demo reset

```bash
pnpm demo:reset        # bank back to the seed, database wiped and re-published, roles, full sync
pnpm sync:verify && pnpm payments:verify
```

## Settings (`.env`)

`STDB_TOKEN` (the sync identity, role SYNC), `NESSIE_API_KEY`, `NESSIE_RUN` (default `dev`), `BANK_MODE=fake` to use the in-memory bank.
