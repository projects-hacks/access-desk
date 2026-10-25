# The living platform

`WORLD_EVENTS=true` (hosted server only) makes Northstar Prime run by itself: the clock keeps moving, billing issues each month, and clients pay, dispute, trade and withdraw at a steady pace, forever. No play, pause or reset. A person can step in at any moment (approve in the console, pay or trade from the client view) and it is handled in the same flow, because the engine only acts through the paths a person would use.

Code: `server/src/world/`, wired in `server/src/index.ts`, using the DEMO identity (`STDB_DEMO_TOKEN`). All decisions come from SpacetimeDB; the process holds only caches, so a restart changes nothing.

## Pace

One tick every 20 to 60 s, never overlapping:

| Step | What |
|---|---|
| 1. Clock | Keep it at `WORLD_SECONDS_PER_DAY` (`set_clock_speed`) |
| 2. Billing | If a month closed, issue its invoices |
| 3. Event | Read the database, pick one client event, do it |

The engine leaves the clock alone if it runs at another pace or with a stop date (someone chose that), or if it was paused less than `WORLD_PAUSE_GRACE_SECONDS` ago (a person may be talking). Paused longer, or after a run-until stop or a reset, it resumes at its pace.

## Billing

Usage for a month is billed on the 1st of the next (period 2026-02 is issued 2026-03-01). When the sim date passes that, every client gets one invoice per product at its monthly fee, due after its terms. Nothing is billed twice: an invoice is skipped if its (client, product, period) already exists in the database or the platform, so a restart or a second run is safe. A clock moved far ahead catches up month by month, 6 at most per run. Each billing run books its invoices and receivable journals (`JE-INV-<id>`) in one `book_invoices` transaction, so a tie-out never sees half of it.

## Personalities

Derived once per client from its own 12-month history, and never changed. When it pays an invoice is a stable function of client and invoice.

| Personality | Derived from | Pays |
|---|---|---|
| `on_time` (20 clients) | median days late 3 or less | up to a week before to 1 day after due |
| `slow` (2) | median 4+ days late | around its historical median |
| `partial` (1) | most invoices settled in 2+ payments | half a week after due, the rest about a month later |
| `gamer` (1) | most payments 15-24 days late | the day before its cure period ends; at once if it already expired |
| `disputer` (1) | 3+ upheld disputes | 27-31 days late, right after its disputes are ruled on |
| `quarter_end` (1) | payments only on quarter ends | the first quarter end on or after due |
| `delinquent` (4) | older periods still unpaid | 60-150 days late, only part of the oldest invoice |

Payment habits come from the January story: ACH debit (Quillon, half the fintechs), SWIFT with a $25 charge (Ostrava), a partner or feeder fund pays (Kestrel, Basalt), client id only (Fieldstone), no reference (Copperline), a $1,000 overpayment (Northfold), repeat wires (Granite Bay), a typo in invoice numbers (Meridian).

## Events

Chosen by weight among everything plausible right now (`chooseEvent`, pure and seeded).

| Event | Weight | What happens |
|---|---|---|
| pay | 20 per client with something ready (up to x3 the longer it waits, x0.25 delinquent) | Wire or ACH debit from the client's own Nessie account quoting invoice numbers: full, partial (about 4%), overpay, short SWIFT, affiliate payer, no-reference styles |
| duplicate wire | 0.08 per paid wire of the last 3 days (1 for repeaters) | Same wire again with a new reference; the module refunds it (pol-013) |
| ACH return | 0.5 per ACH debit of the last 7 days | R01 return naming the original trace; the module reopens the invoices (pol-015) |
| withdraw | 0.35 (x8 for a gamer in its cure period) | `request_custody_withdrawal` for 2-10% of free cash; the module decides, the gateway wires it |
| dispute | 1.2 disputer; 1.5 gamer in the last 6 days of its cure period; 0.08 anyone else not delinquent. Only if the client has none under review and fewer than 5 are open in all | The platform opens one on the oldest overdue unpaid invoice it would not yet pay (whole invoice for disputers and gamers, 25-100% for others). The module wakes Iris and Rowan and excludes the invoice from holds and collection |
| resolve dispute | 12 when the ruling is due | Due 2 days before a disputer would have paid (at least 12 days after opening), 15-25 days for a gamer, 10-20 for others. Disputers and gamers are upheld as billed 90% of the time, others 50/50 |
| trade | 1.2 | `place_order` at the live price, 0.5-4% of a holding or 5-20% of free cash, $1k-$300k. Under paused trading: mostly sells, now and then a refused buy |

## Disputes

The platform simulator holds disputes (`openDispute`, `resolveDispute`), mirrored into the database through `sync.bookDispute` and `upsert_dispute`. The dataset's own live disputes (Orchard, Kestrel) can be ruled on too, so a serial disputer is not capped forever by an old one. Live ids are `DSP-W0001` and up.

| Ruling | Effect |
|---|---|
| `no_change` | Invoice reopens as billed, books unchanged |
| `credited` | Credit note of 15-60% of the disputed amount: the invoice shrinks, billing books Dr revenue / Cr receivables (`JE-CN-<dispute id>`), and the dispute row records the credit. Invoice and journal go in one `book_invoices` transaction, so a tie-out never sees half |

On boot `openPlatform` reads dispute rows back, restores credited invoices to their original amount and re-issues each credit note identically.

## Balance and limits

| Rule | Value |
|---|---|
| Events per client per sim day | `WORLD_CLIENT_DAY_CAP` (2), counted from the database |
| Disputes under review | 1 per client, 5 in all |
| Nessie writes per minute | `WORLD_BANK_WRITES_PER_MINUTE` (20) |
| Simulated 120 days (test) | 55%+ of paid invoices on time (typically 62-69%), about 82% within a week, under 5% over a month late; disputes are about 1% of events, mostly upheld |

Bank references are `WI-6000..9999` (wires), `AC-8000..9999` (ACH), then `WE-nnnnn`, always above every reference already in the database or bank, so none repeats. Not modelled: USDC payments (the chain feed is a dataset constant) and Nessie bills for new invoices.

## Observe

Log line: `[world] 2026-04-09 pay · Kestrel Quant wire via its affiliate $288,870.00 for INV-1815 ... (on_time) · WI-6014 matched`. `GET /world/state` (read only) returns pace, clock and who owns it, totals, counts per kind and personality, last billing, bank writes used, last error and the last 20 events.

```bash
pnpm --filter @access-desk/server world:plan [events=20] [seed]   # next events, reads the database, writes nothing
```

## Env

| Variable | Default |
|---|---|
| `WORLD_EVENTS` | `false` |
| `WORLD_SECONDS_PER_DAY` | `240` (0 leaves the clock alone) |
| `WORLD_EVENT_MIN_SECONDS` / `WORLD_EVENT_MAX_SECONDS` | `20` / `60` |
| `WORLD_CLIENT_DAY_CAP` | `2` |
| `WORLD_BANK_WRITES_PER_MINUTE` | `20` |
| `WORLD_PAUSE_GRACE_SECONDS` | `300` |
