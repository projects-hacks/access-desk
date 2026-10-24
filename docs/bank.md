# Bank (Nessie)

Capital One's Nessie API is the platform's bank. All client payments land in it, and all money leaving the platform goes out through it. Everything else (billing, custody, positions, loans, CRM) lives in our simulator.

- API: `https://prod-api.nessieisreal.com`, with the key as `?key=` (`NESSIE_API_KEY` in `.env`)
- Docs: https://prod.nessieisreal.com/docs (no data dashboard; use `pnpm bank show`)
- Platform name comes from `PLATFORM_NAME` / `PLATFORM_LEGAL_NAME` in `.env`

## Commands

```bash
pnpm seed:nessie                      # dry run: prints the plan and every planted case
pnpm seed:nessie --apply              # create run "dev" (resumes if interrupted)
pnpm seed:nessie --apply --run demo   # separate run for judging, own customers

pnpm bank show                        # Collections account: transactions
pnpm bank show ORG-90412              # a client's bank side: payments sent + bills
pnpm bank settle WI-5531              # post a pending wire (both sides); then POST /sync/now
pnpm bank reset                       # back to exactly as seeded; deletes anything created since

pnpm test                             # includes the in-memory fake bank
```

Add `--run demo` to `bank` commands to target the demo run. Created Nessie ids live in `.data/nessie-<run>.json`, committed so the whole team shares one bank. Sync and reset read that file. After seeding a new run, commit its file.

## Rules

- **Amounts are integer cents** (`14820000` = $148,200.00). Bills are the exception: `payment_amount` is in dollars.
- **Nessie never moves balances.** We compute every balance ourselves.
- **Nothing settles on its own.** Pending stays pending until `bank settle` or the gateway updates it.
- **A bank record dated after the sim date is invisible** to sync. That's how the demo wire (dated Mar 10) stays hidden.
- **Data is public and customers can't be deleted.** Use fictional names only, and reset instead of re-seeding.

## Memo format

Nessie has no counterparty fields, so the remittance info goes in `description`. Parse it with `parseMemo` in `server/src/integrations/nessie/memo.ts`.

```
WIRE IN | ORIG: Kestrel Quant LP | ORIG_ACCT: 4410220791334512 | REF: INV-1057 INV-1061 | ID: WI-5531
```

Types: `WIRE IN`, `WIRE OUT`, `ACH IN`, `ACH RETURN R01 NSF`, `BANK FEE`. Every payment is recorded on both sides: a withdrawal on the payer's account and a deposit on ours, both with the same `ID`.

## What's seeded

| Accounts | Purpose |
|---|---|
| `<Platform> · Collections` | Every incoming client payment |
| `<Platform> · Disbursements` | Loan payouts, client withdrawals |
| One per client and affiliate | Payment source; invoices are presented here as bills |

Sim date: **Tue 2026-03-03**. The bank window is Feb 1 to Mar 3 (older history lives in the simulator). The planted cases and their expected outcomes are in `server/src/dataset/scenario.ts`; run the dry run to see them with real amounts.

## Code

| File | What |
|---|---|
| `server/src/dataset/` | The demo world: clients, invoices, payments, answer key. Deterministic, and validated on load |
| `server/src/integrations/nessie/client.ts` | Typed Nessie client (`NessieApi`) |
| `server/src/integrations/nessie/fake.ts` | In-memory bank with the same interface (tests, fallback) |
| `server/src/integrations/nessie/seed-plan.ts` | Dataset → exact Nessie records |
| `server/src/scripts/seed-nessie.ts`, `bank.ts` | The commands above |
