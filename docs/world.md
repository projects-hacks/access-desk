# The living platform

`WORLD_EVENTS=true` (hosted server only) makes Northstar Prime run by itself: the clock keeps moving, billing issues each month, and clients pay, trade and withdraw at a steady pace, forever. No play, pause or reset. A person can step in at any moment (approve in the console, pay or trade from the client view) and it is handled in the same flow, because the engine only ever acts through the same paths a person would.

Code: `server/src/world/`. Wired in `server/src/index.ts`; uses the DEMO identity (`STDB_DEMO_TOKEN`).

## One tick (every 20-60 s, never overlapping)

| Step | What | Where it goes |
|---|---|---|
| 1. Clock | keep it at `WORLD_SECONDS_PER_DAY` | `set_clock_speed` |
| 2. Billing | a month closed: issue its invoices | platform `issue()`, then `sync.full()` |
| 3. Event | read the database, pick one client event, do it | Nessie wire/ACH then `sync.cash`; or `place_order`, `request_custody_withdrawal` |

## Clock rule

| Clock now | Engine does |
|---|---|
| Running at its pace | nothing |
| Running at another pace, or with a stop date | leaves it (someone chose that), logs once |
| Paused for less than `WORLD_PAUSE_GRACE_SECONDS` | leaves it (a person may be talking) |
| Paused longer (also after a run-until stop or a reset) | resumes it at its pace |

## Billing

Usage for a month is billed on the 1st of the next (as the dataset does: period 2026-02 issued 2026-03-01). When the sim date passes that, every client gets one invoice per product at its monthly fee (same wobble as the dataset), due after its terms, numbered after the highest existing number. Skipped if `(client, product, period)` already exists in the database or the platform, so a restart mid-month, or a second run, bills nothing twice. A clock moved far ahead catches up month by month (6 at most per run). The platform books Dr receivables / Cr revenue (`JE-INV-<id>`) so the tie-out stays tied. On boot `openPlatform` reads issued invoices back from the database before replaying gateway commands.

## Personalities

Derived once per client from its own dataset history (12 months of payments, disputes, January story); a client never changes. When it pays an invoice is a stable function of client and invoice (`readyOn`).

| Personality | Derived from | Pays |
|---|---|---|
| `on_time` (20) | median days late ≤ 3 | up to a week before to 1 day after due |
| `slow` (2) | median 4+ days late | around its historical median (+/- half) |
| `partial` (1) | most invoices settled in 2+ payments | ~half a week after due, rest ~a month later |
| `gamer` (1) | most payments 15-24 days late | the day before its cure period ends (reads the `deadline`); at once if it already expired |
| `disputer` (1) | 3+ upheld disputes | 27-31 days late, right after its disputes are ruled on |
| `quarter_end` (1) | payments only on quarter ends | the first quarter end on or after due |
| `delinquent` (4) | older periods still unpaid, January open | 60-150 days late, only part of the oldest invoice, so it never catches up |

Habits from the January story: ACH debit (Quillon and half the fintechs), international SWIFT with a $25 intermediary charge (Ostrava), general partner or feeder fund pays (Kestrel/Zephyr, Basalt/feeder), client id only on catch-up wires (Fieldstone), no reference (Copperline), $1,000 overpayment (Northfold), repeat wires (Granite Bay), a keyed typo in invoice numbers (Meridian).

## Events

Chosen by weight among everything plausible right now (`chooseEvent`, pure and seeded):

| Event | Weight | Path | Notes |
|---|---|---|---|
| pay | 20 per client with something ready (x up to 3 the longer it waits; x0.25 delinquent) | wire or ACH debit from the client's own Nessie account, quoting invoice numbers | full, partial (~4%), overpay, short SWIFT, affiliate payer, no-reference styles |
| duplicate wire | 0.08 per paid wire of the last 3 days (1 for repeaters) | same wire again, new reference | module refunds it (pol-013) |
| ACH return | 0.5 per ACH debit of the last 7 days | R01 return naming the original trace | module reopens the invoices (pol-015) |
| withdraw | 0.35 (x8 for a gamer in its cure period) | `request_custody_withdrawal`, 2-10% of free cash | module decides; gateway wires it |
| dispute | 1.2 disputer; 1.5 gamer in the last 6 days of its cure period; 0.08 anyone else (not delinquent); only if the client has none under review and fewer than 5 are open in all | the platform opens it (`sync.bookDispute` → `upsert_dispute`); the module wakes Iris and Rowan and excludes the invoice from holds and collection | the oldest overdue unpaid invoice it would not yet pay; whole invoice for disputers and gamers, 25-100% for others; reason fits the product |
| resolve dispute | 12 when the ruling is due | same path | due 2 days before a disputer would have paid (min 12 days after opening), 15-25 days for a gamer, 10-20 for others; disputers and gamers upheld as billed 90%, others 50/50 |
| trade | 1.2 | `place_order` at the live price, 0.5-4% of a holding or 5-20% of free cash, $1k-$300k | paused trading: mostly sells, now and then a refused buy |

## Disputes

The platform simulator holds disputes (`openDispute`, `resolveDispute`); `platformRecords` and `sync.bookDispute` mirror them through the existing `upsert_dispute` path, ahead of the dataset's baseline copy of the same id. The dataset's own live disputes (Orchard, Kestrel) can be ruled on too, so a serial disputer is not capped forever by an old one.

| Ruling | Effect |
|---|---|
| `no_change` | invoice reopens as billed; books unchanged |
| `credited` | credit note of 15-60% of the disputed amount: the invoice shrinks, billing books Dr revenue / Cr receivables (`JE-CN-<dispute id>`), and the dispute row records the amount credited. Invoice and journal go in one `book_invoices` transaction after the ruling, so a tie-out never sees half |

Live ids are `DSP-W0001...`. On boot `openPlatform` reads dispute rows back, puts credited invoices at their original amount, and re-issues each credit note (identical journal), so a restart changes nothing.

## Balance and limits

| Rule | Value |
|---|---|
| Events per client per sim day | `WORLD_CLIENT_DAY_CAP` (2), counted from the database |
| Disputes under review | 1 per client, 5 in all |
| Nessie writes per minute | `WORLD_BANK_WRITES_PER_MINUTE` (20) |
| Invoices in flight | not paid again until the first payment is matched (database or 2 min) |
| Simulated 120 days (test) | 55%+ of paid invoices on time (typically 62-69%), ~82% within a week, <5% over a month late; what stays overdue belongs to delinquent / quarter-end / disputer / partial clients; dispute events are ~1% of events (6-9 opened, mostly upheld) |

## Restarts and overlap

All decisions come from SpacetimeDB (invoices, cash, levers, custody, deadlines, clock); the process holds only caches. Bank references are `WI-6000..9999` (wires), `AC-8000..9999` (ACH), then `WE-nnnnn`; the next is above every reference in the database, the bank (listed at start) and this process, so none repeats (payment checking recognizes only `WI-nnnn` / `AC-nnnn` in a refund remittance, hence the ranges). A tick that is still running makes the next one return.

## Observe

Log: `[world] 2026-04-09 pay · Kestrel Quant wire via its affiliate $288,870.00 for INV-1815 ... (on_time) · WI-6014 matched`.

`GET /world/state` (read only): pace, clock and who owns it, totals, counts per kind and per personality (with client names), last billing, bank writes used, last error, last 20 events.

Dry run (reads the database, writes nothing; works without `SERVER_HOST`):

```bash
pnpm --filter @access-desk/server world:plan [events=20] [seed]
```

## Not modelled

| Gap | Why |
|---|---|
| USDC payments | the chain feed is a dataset constant, and sync deletes chain rows not in it |
| Nessie bills for new invoices | not created; bill status updates skip them |

## Env

| Variable | Default |
|---|---|
| `WORLD_EVENTS` | `false` |
| `WORLD_SECONDS_PER_DAY` | `240` (0 = leave the clock) |
| `WORLD_EVENT_MIN_SECONDS` / `WORLD_EVENT_MAX_SECONDS` | `20` / `60` |
| `WORLD_CLIENT_DAY_CAP` | `2` |
| `WORLD_BANK_WRITES_PER_MINUTE` | `20` |
| `WORLD_PAUSE_GRACE_SECONDS` | `300` |
