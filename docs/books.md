# Gateway, ledger and tie-out

## Gateway: the only writer to systems of record

Reducers never write to the platform directly. They queue a `gateway_command` (idempotent by `key`); the gateway executes commands strictly in id order and reports back.

```
reducer → gateway_command (queued) → gateway claims → platform API / bank → complete (state written through) | fail (retry or escalate)
```

| Command | System of record | What comes back |
|---|---|---|
| `APPLY_PAYMENT`, `REVERSE_PAYMENT` | Billing (`/platform/billing/...`) | Invoice paid amounts and dates |
| `POST_JOURNAL` | General ledger (`/platform/gl/journals`) | Journal id; lines written to `ledger_entry` |
| `PLACE_HOLD`, `RELEASE_HOLD`, `SET_LEVER` | Admin console (`/platform/admin/...`) | Lever state |
| `CUSTODY_DEBIT` | Custody (`/platform/custody/debits`) | Balances and invoices; applications marked posted |
| `CUSTODY_WITHDRAWAL` | Custody (`/platform/custody/withdrawals`), then a Nessie wire `CW-nnnn` | Balances, Nessie ids |
| `REFUND` | Bank (Nessie: withdrawal + client deposit) | Nessie ids |
| `SEND_NOTICE` | Messaging (`/platform/notices`) | Message id |

- Code: `server/src/gateway/executor.ts`, contract in `server/src/platform/commands.ts` (zod), module side in `spacetime/src/reducers/gateway.ts`.
- Identity: its own token (`STDB_GATEWAY_TOKEN`, role GATEWAY). Claiming makes double execution impossible.
- Bills: after any command that changes invoices, the matching Nessie bill is set to `completed` (paid) or back to `pending` (reversed). Best effort, off the critical path.
- A work item moves APPROVED → POSTED once every command it queued is done.
- Failures: platform refusals (422) are permanent → `failed` + a `SYSTEM_EXCEPTION` work item for the controller. Network errors retry with backoff (5 attempts), blocking later commands so order holds.
- Billing vs us: `payment_application.posted` / `reversal_posted` record what billing confirmed; invoice paid = billing's figure + Σ(what we count − what billing counts). Correct at every moment, including mid-flight.

## The simulated platform

`server/src/platform/simulator.ts`: billing, GL, admin console, custody, notices. State = dataset baseline + every completed command replayed in order (`openPlatform`), so restarts and fresh processes agree, and a database reset (no commands) returns the baseline.

## General ledger

| Account | |
|---|---|
| 1010 / 1011 / 1015 | Cash: Collections, Disbursements, USDC wallet |
| 1200 | Accounts receivable |
| 1300 | Loans receivable |
| 2100 | Client funds |
| 2300 | Unapplied cash and credits |
| 3000 | Equity (opening bank balances) |
| 4100–4400 | Revenue: custody, trading, financing, API |
| 6850 | Bank fees |

Baseline (`server/src/dataset/gl.ts`): billing booked invoices and the cash it applied; treasury booked receipts that posted before our system ran. Our system books, through the gateway: receipts it is first to see (Dr cash / Cr 2300), applications (Dr 2300 / Cr 1200), write-offs (Dr 6850 / Cr 1200), returns (Dr 1200 / Cr cash), bank fees, loan movements, refunds (Dr 2300 / Cr cash), custody debits (Dr 2100 / Cr 1200), custody withdrawals (Dr 2100 / Cr 1011). A journal is never posted for a source document the ledger already has.

## Tie-out

`spacetime/src/books/tieout.ts`, run after every sync pass, every gateway drain and every clock advance. Results in `tie_out_run` / `tie_out_break`.

| Area | Operations side | Ledger side |
|---|---|---|
| Cash, per account | Posted bank/chain movements | 1010 / 1011 / 1015 |
| Receivables | Open invoice balances (issued ≤ today) | 1200 |
| Unapplied | Cash received minus cash applied | 2300 |

Breaks: `in_transit` (pending wires), `awaiting_gateway` (journals queued), `unexplained` (→ `BOOKS_BREAK` work item for the controller).

## Checks

```bash
pnpm sync               # full pass + gateway drain + tie-out
pnpm ledger:verify      # journals balance, ledger = platform GL, every decision booked, billing agrees
pnpm tieout:verify      # baseline ties; a planted stray GL line is caught and escalated (then: pnpm demo:reset)
```

## Bank balances

Nessie's balance field never moves, so `bank_account` holds statement balances computed from its transactions: opening + posted, pending in and out separately, available = posted − pending out. Platform openings equal the GL's `JE-OPEN` plus the history receipts that predate the bank window, so a statement balance equals GL cash; tie-out compares opening + posted movements per account. Client openings are a tier-based cushion. Platform accounts refresh every cash pass; client accounts on the full pass and whenever the gateway or a demo wire moves their money.
