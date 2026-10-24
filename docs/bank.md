# Bank (Nessie)

Capital One's Nessie API is the platform's bank. All client payments land in it, and all money leaving the platform goes out through it. Everything else (billing, custody, positions, loans, CRM) lives in our simulator.

- API: `https://prod-api.nessieisreal.com`, with the key as `?key=` (`NESSIE_API_KEY` in `.env`)
- Docs: https://prod.nessieisreal.com/docs (no data dashboard; use `pnpm bank show`)
- Platform name defaults to Northstar Prime; set `PLATFORM_NAME` / `PLATFORM_LEGAL_NAME` in `.env` to rename

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

With `DEMO_CONTROLS=true` the server does the same through HTTP: `POST /demo/inject` (a payment typed by anyone: payer, amount, remittance, Fedwire or SWIFT with charges, posted or pending; returns how it was parsed and matched), `/demo/settle {bankRef}`, `/demo/advance {days}`, `/demo/reset`, `GET /demo/state`.

Add `--run demo` to `bank` commands to target the demo run. Created Nessie ids live in `.data/nessie-<run>.json`, committed so every checkout uses the same bank. Sync and reset read that file. After seeding a new run, commit its file.

## Rules

- **Amounts are integer cents** (`14820000` = $148,200.00). Bills are the exception: `payment_amount` is in dollars.
- **Realism:** formats and behaviour follow `research/140-real-world-cash-ops.md` (Fedwire/SWIFT field limits, SHA charges on international wires, ACH R01 on debits we originate, no memo on USDC).
- **Nessie never moves balances.** We compute every balance ourselves.
- **Nothing settles on its own.** Pending stays pending until `bank settle` or the gateway updates it.
- **A bank record dated after the sim date is invisible** to sync. That's how the demo wire (dated Mar 10) stays hidden.
- **Data is public and customers can't be deleted.** Use fictional names only, and reset instead of re-seeding.

## Memo format

`description` carries bank statement text the way a US bank shows it (uppercase, names cut to 35 characters, remittance capped at 140, or 80 for ACH addenda). Formats, from `server/src/integrations/bank-text/format.ts`:

```
WIRE TYPE:FED IN DATE:260303 TRN:WI-5419 IMAD:... ORIG:MERIDIAN FLOW PARTNERS LLC ID:<acct> SND BK:JPMORGAN CHASE BANK NA ID:021000021 PMT DET:INVOICES I776, 1777 & 1778
WIRE TYPE:INTL IN DATE:260303 TRN:WI-5420 UETR:... ORIG:OSTRAVA DIGITAL ASSETS LP ID:<acct> SND BK:CESKA SPORITELNA AS ID:GIBACZPX INSTD AMT:USD40520.00 CHGS:SHA USD25.00 PMT DET:/INV/1802 1803 /RFB/JAN26
ACH CCD DEBIT COLLECTION TRACE:AC-7101 CO:QUILLON SYSTEMS INC ACCT:<acct> IND ID:ORG90689 ADDENDA:INV-1769 JAN API USAGE
ACH RETURN R01 INSUFFICIENT FUNDS TRACE:AC-7102 ORIG TRACE:AC-7101 CO:QUILLON SYSTEMS INC ACCT:<acct>
ACCOUNT ANALYSIS FEE TRN:BF-2026-02 PERIOD:2026-02 INCOMING WIRES 8 @ 15.00
WIRE TYPE:FED OUT DATE:260209 TRN:WI-5401 BNF:HALCYON CAPITAL LLC ID:<acct> RCV BK:... PMT DET:LN-2201 DRAWDOWN
```

Each client writes references its own way (`INV1050 INV1051`, `INV-1050/1051`, `INVOICES 1050, 1051 & 1052`, `PMT INV 1050-1052`, `/INV/1050 1051`), some with typos, some in words only. `parseBankText` (`bank-text/parse.ts`) reads it back into fields with a confidence and notes; Claude (`bank-text/interpret.ts`, needs `ANTHROPIC_API_KEY`) reads free-text remittance the rules can't. Every payment is recorded on both sides: a withdrawal on the payer's account and a deposit on ours, with the same reference.

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
