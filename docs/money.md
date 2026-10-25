# How a dollar moves

Cash comes in through the bank (Capital One's Nessie sandbox). Sync records it, a reducer matches and applies it in one transaction, and anything that must change in the outside world goes through the gateway, the only writer to systems of record. The ledger and tie-out then check that the books agree with the bank.

## The bank (Nessie)

All client payments land in Nessie, and all money leaving the platform goes out through it. Billing, custody, positions, loans and CRM live in our simulator (`server/src/platform/simulator.ts`).

- API `https://prod-api.nessieisreal.com`, key as `?key=` (`NESSIE_API_KEY`). Docs: https://prod.nessieisreal.com/docs. No data dashboard: use `pnpm bank show`.
- Accounts: `<Platform> · Collections` (every incoming payment), `<Platform> · Disbursements` (loan payouts, client withdrawals), and one per client and affiliate (payment source; invoices appear there as bills).
- Sim date starts Tue 2026-03-03. The bank window is Feb 1 to Mar 3; older history lives in the simulator.

```bash
pnpm seed:nessie                      # dry run: prints the plan and every planted case
pnpm seed:nessie --apply              # create run "dev" (resumes if interrupted)
pnpm seed:nessie --apply --run demo   # separate run for judging, own customers
pnpm bank show [ORG-90412]            # Collections transactions, or one client's bank side
pnpm bank settle WI-5531              # post a pending wire (both sides); then POST /sync/now
pnpm bank reset                       # back to exactly as seeded
```

Add `--run demo` to `bank` commands to target the demo run. Created Nessie ids live in `.data/nessie-<run>.json`, committed so every checkout uses the same bank. With `DEMO_CONTROLS=true` the server offers the same over HTTP: `POST /demo/inject` (any payment: payer, amount, remittance, Fedwire or SWIFT with charges, posted or pending; returns how it was parsed and matched), `/demo/settle`, `/demo/advance`, `/demo/clock`, `/demo/withdraw`, `/demo/reset`, `GET /demo/state`.

Rules that shape the data:

- Amounts are integer cents. Bills are the exception: `payment_amount` is dollars.
- Nessie never moves balances, so we compute them ([bank balances](#bank-balances)).
- Nothing settles on its own. Pending stays pending until `bank settle` or the gateway updates it.
- A bank record dated after the sim date is invisible to sync. That keeps the demo wire (dated Mar 10) hidden.
- Nessie data is public and customers cannot be deleted. Use fictional names; reset instead of re-seeding.

**Memo text.** `description` carries statement text as a US bank shows it (uppercase, names cut to 35 characters, remittance capped at 140), for example `WIRE TYPE:INTL IN ... INSTD AMT:USD40520.00 CHGS:SHA USD25.00 PMT DET:/INV/1802 1803`. Each client writes references its own way (`INV1050 INV1051`, `INVOICES 1050, 1051 & 1052`, `/INV/1050 1051`), some with typos, some in words only. `parseBankText` (`server/src/integrations/bank-text/parse.ts`) reads it into payer name and account, bank reference, invoice, client and loan references (typos repaired and flagged), instructed amount and charges, and ACH return codes. Each movement records `parsed_by` (rules or claude), `parse_confidence` and `parse_notes`. Claude (`interpret.ts`, needs `ANTHROPIC_API_KEY`) reads only remittance with no recognizable references; its answer narrows matching by period, product and purpose, and amounts must still fit exactly.

Code: `server/src/dataset/` (demo world and answer key), `server/src/integrations/nessie/` (`client.ts` API, `fake.ts` in-memory bank for tests and `BANK_MODE=fake`).

## Sync

Sync pulls every system of record into the shared database. **Run it in one place only**: one server per database. Everything else just reads.

```bash
pnpm dev:server        # SERVER_HOST=true: full sync on start, bank + chain every 5 s, everything every 60 s
pnpm sync              # one full pass, then exit
pnpm sync:verify       # check the database against the sources (exit 1 on any mismatch)
curl -X POST localhost:4000/sync/now   # pull the bank immediately, e.g. after settling a demo wire
pnpm demo:reset        # bank back to the seed, database wiped and re-published, roles, full sync
```

| Source | Feeds | From |
|---|---|---|
| `crm` | client, payer_identity, contract, contract_clause | dataset |
| `billing` | invoice, dispute | dataset |
| `platform_admin` | capability, access_lever | dataset |
| `custody` | custody_holding, asset_price, owed_to_client | dataset |
| `positions` | position, loan | dataset |
| `gl` | ledger_entry | platform simulator's general ledger |
| `bank`, `bank_balances` | cash_movement, bank_account | Nessie, the platform's Collections and Disbursements accounts |
| `chain` | cash_movement | dataset (USDC to the platform wallet) |
| `history` | cash_movement (`is_history`), precedent, metric_snapshot | dataset, 12 months |

Status for each is in `sync_source`.

- Order: platform systems, history, bank, chain. Live cash is written in date order, one movement at a time, so outcomes never depend on timing.
- Only changed rows are written, each with a `raw_record` of the source payload. Cash dated after `clock.sim_date` is skipped.
- Fields our system owns (`match_status`, client status and tier, lever state, loan borrowing, invoice paid and status) are never overwritten by a re-sync.
- An unknown memo type, status or missing id fails the pass loudly.

Settings (`.env`): `STDB_TOKEN` (role SYNC), `NESSIE_API_KEY`, `NESSIE_RUN` (default `dev`), `BANK_MODE=fake`.

## Payment checking

Runs inside the SpacetimeDB module (`spacetime/src/reducers/payments.ts`), in the same transaction that records the cash. The payment, its application, any hold release and the audit rows land together.

1. **Who paid.** Account or wallet in `payer_identity` (affiliates included), then name, then a quoted client id, then a quoted invoice. Nobody found: `UNIDENTIFIED_CASH`.
2. **What it pays** (`spacetime/src/payments/match.ts`, pure and unit-tested). The quoted invoices exactly; quoted invoices short by $50 or less (rest booked to bank fees, pol-002); quoted invoices overpaid (excess held as credit, pol-012); otherwise the exact set of open invoices by amount, oldest debt first (wrong or missing references); otherwise a partial payment, oldest first.
3. **No double counting.** Cash first covers what billing already applied (`method = 'prior'`). That is also how a second wire for paid invoices is caught as a duplicate, and how a returned payment reopens its invoices.
4. **Act or ask.** Payer known by account or wallet: applied automatically. Name-only payer, unknown payer or an unreferenced partial: a work item for a person.
5. **Consequences.** A hold releases when the invoices it secures are paid (pol-011): lever restored, client active, `gateway_command` queued. Open restriction proposals for a client no longer overdue are withdrawn. Pending wires are `in_transit`, so nobody is restricted while a payment is on its way.

The planted cases and what the module does (answer key in `server/src/dataset/scenario.ts`):

| Case | Client | Outcome |
|---|---|---|
| Affiliate or feeder fund pays | Kestrel (Zephyr Capital), Basalt | Mapped to the parent through the CRM, applied (pol-004). Kestrel's hold releases in under a second |
| International wire short $25 | Ostrava | Instructed amount minus SHA charges equals what arrived: applied in full, $25 to bank fees (pol-002) |
| Catch-up wire with only the client id | Fieldstone | Exact set of open invoices that sums to the wire |
| No reference, abbreviated name | Copperline | Payer found by originator account, matched by amount |
| Wrong invoice numbers quoted | Cinder Peak | Matched to the open invoices by amount |
| Cash arrived, invoices show overdue | Saltmarsh | Remittance read in words, applied, restriction proposal dropped |
| Half of one invoice paid | Wrenfield | Applied; aging continues on the balance |
| Wire sent, not yet posted | Ivory Lane | Nobody restricted until it posts |
| Pays from an unseen account | Harbor & Pine | Matched by name and amount at lower confidence, applied, account added to the CRM |
| Overpayment of $1,000 | Northfold | Applied, excess held as credit (pol-012) |
| Duplicate wire | Granite Bay | First applied. Second refunded to the sender through the bank, no approval (pol-013) |
| ACH returned R01 | Quillon | Applications reversed, invoices reopen (pol-015) |
| USDC from a known / an unknown wallet | Silverline / nobody | Matched by wallet and amount / parked as unapplied cash with a return-by date ([Iris](agents.md#iris-on-the-books)) |

Everything payment checking cannot settle is a `work_item` with evidence in `proposal_json`: `UNIDENTIFIED_CASH`, `PAYMENT_MATCH` (`PROPOSED`), `REFUND`, `UNAPPLIED_CASH`, `BOOKS_BREAK`, `SYSTEM_EXCEPTION`. Agents investigate and propose; a person approves with `transition_work_item`. Approving a `PAYMENT_MATCH` (ACCOUNTANT or CONTROLLER) applies it and adds a new bank account to the CRM if one was proposed.

Data: `invoice.source_paid_cents` is billing's figure; `paid_cents` and `status` are recomputed from it plus our applications. `payment_application.method` is `referenced`, `exact`, `split`, `short_fee`, `overpaid` or `partial` for cash, `write_off` for the short amount, `custody_debit` for custody collections, `prior` for cash billing applied before us. `client_credit.kind` is `overpayment` or `unapplied_cash`.

## Refunds and returns

| Case | What happens |
|---|---|
| Duplicate wire | `REFUND` work item, auto-applied (pol-013). Gateway makes a Nessie withdrawal and a client deposit and books Dr 2300 / Cr cash |
| Bank returns a payment (ACH) | Applications reversed, invoices due again, journal posted (Dr 1200 / Cr cash). One we had applied ourselves comes out of unapplied cash, not receivables a second time |
| Unidentified cash past its return-by date | `return_cash` queues `RETURN_PAYMENT`: the gateway wires it back through Nessie. USDC is kept as unclaimed cash instead |
| Client withdrawal | `CUSTODY_WITHDRAWAL` at custody, then a Nessie wire `CW-nnnn` |

## The gateway

Reducers never write to the platform directly. They queue a `gateway_command` (idempotent by `key`) and the gateway executes commands strictly in id order.

```
reducer -> gateway_command (queued) -> gateway claims -> platform API / bank -> complete (state written back) | fail (retry or escalate)
```

| Command | System of record |
|---|---|
| `APPLY_PAYMENT`, `REVERSE_PAYMENT` | Billing: invoice paid amounts and dates |
| `POST_JOURNAL` | General ledger: lines written to `ledger_entry` |
| `PLACE_HOLD`, `RELEASE_HOLD`, `SET_LEVER` | Admin console: lever state |
| `CUSTODY_DEBIT`, `CUSTODY_WITHDRAWAL` | Custody: balances and invoices; withdrawals then wire through Nessie |
| `REFUND`, `RETURN_PAYMENT` | Bank (Nessie) |
| `SEND_NOTICE` | Messaging |
| `TRADE` | Trading |

- Code: `server/src/gateway/executor.ts`, contract in `server/src/platform/commands.ts` (zod), bank side in `server/src/gateway/bank.ts`, module side in `spacetime/src/reducers/gateway.ts`.
- Its own token (`STDB_GATEWAY_TOKEN`, role GATEWAY). Only `queued` commands can be claimed, so nothing runs twice.
- After a command that changes invoices, the matching Nessie bill is set to `completed` or back to `pending` (best effort).
- A work item moves APPROVED to POSTED once every command it queued is done.
- A platform refusal (422) is permanent: `failed` plus a `SYSTEM_EXCEPTION` item. Network errors retry with backoff, 5 attempts, and block later commands so order holds. A command stuck `executing` for 60 s goes back to the queue.
- Invoice paid = billing's figure + (what we count - what billing counts), so it is right at every moment, including mid-flight.

The simulated platform (`server/src/platform/simulator.ts`) is the dataset baseline plus every completed command replayed in order, so restarts agree with the database.

## Ledger and tie-out

Accounts: cash 1010 Collections, 1011 Disbursements, 1015 USDC wallet; 1200 receivables; 1300 loans receivable; 2100 client funds; 2300 unapplied cash and credits; 3000 equity (opening balances); 4100-4400 revenue; 6850 bank fees.

The baseline (`server/src/dataset/gl.ts`) has billing's invoices and applied cash, and treasury receipts from before our system ran. We book through the gateway: receipts we are first to see (Dr cash / Cr 2300), applications (Dr 2300 / Cr 1200), write-offs (Dr 6850 / Cr 1200), returns (Dr 1200 / Cr cash), refunds (Dr 2300 / Cr cash), custody debits (Dr 2100 / Cr 1200) and withdrawals (Dr 2100 / Cr 1011). A journal is never posted for a source document the ledger already has.

**Tie-out** (`spacetime/src/books/tieout.ts`) runs after every sync pass, gateway drain and clock advance. Results are in `tie_out_run` and `tie_out_break`.

| Area | Operations side | Ledger side |
|---|---|---|
| Cash, per account | Posted bank and chain movements | 1010 / 1011 / 1015 |
| Receivables | Open invoice balances (issued on or before today) | 1200 |
| Unapplied | Cash received minus cash applied | 2300 |

A difference is `in_transit` (pending wires), `awaiting_gateway` (journals queued) or `unexplained`. Unexplained raises a `BOOKS_BREAK` item and a red alert on every screen, and wakes Iris to trace and correct it ([agents](agents.md#iris-on-the-books)).

### Bank balances

Nessie's balance field never moves, so `bank_account` holds statement balances computed from its transactions: opening plus posted, pending in and out separately, available = posted minus pending out. Platform openings equal the GL's `JE-OPEN` plus history receipts from before the bank window, so a statement balance equals GL cash.

## History

Mar 2025 to Jan 2026, before the bank window, generated in `server/src/dataset/history.ts` and synced by the `history` source. It goes through payment checking quietly: no work items, no ticker rows.

| Data | Where | Count |
|---|---|---|
| Invoices, all paid, with `paid_on` | `invoice` issued before 2026-01-01 | about 670 |
| Payments billing applied | `cash_movement` with `is_history = true` | 339 |
| Past decisions and outcomes | `precedent`, `source = 'history'` | 12 |
| Weekly trend | `metric_snapshot` (`share_needing_human`, `handled_automatically`) | 12 weeks |

The six patterns Rowan looks for are planted in it (Juniper pays on day 20, Orchard disputes every invoice, and so on: [agents](agents.md#exploit-checks-rowan)). PRC-0001 to PRC-0003 are overrides of "hold amount + no new positions" to "hold amount only" near renewal; Kestrel's live override makes four. Cash leaving custody during a cure period is live only (`POST /demo/withdraw` for Cobalt Ridge or Kestrel).

## Check it

```bash
pnpm --filter @access-desk/spacetime test   # matching rules, one test per planted case
pnpm payments:verify                        # live results against the answer key (fresh database)
pnpm ledger:verify                          # journals balance, ledger = platform GL, every decision booked
pnpm tieout:verify                          # baseline ties; a planted stray GL line is caught (then: pnpm demo:reset)
```

Demo wire: `pnpm bank settle WI-5531`, then `POST /sync/now`. Measured: 0.66 s from sync to hold released.
