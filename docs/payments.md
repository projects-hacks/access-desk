# Payment checking

Runs inside the SpacetimeDB module (`spacetime/src/reducers/payments.ts`), in the same transaction that records the cash. A payment, its application, any hold release and the audit rows land together, and every screen sees them at once.

## Input: messy bank text

Bank text is parsed before payment checking sees it (`server/src/integrations/bank-text/`): payer name and account, bank reference, remittance, invoice/client/loan references (typos repaired and flagged), instructed amount and charges on international wires, ACH return codes. Each movement records `parsed_by` (rules or claude), `parse_confidence` and `parse_notes`. Claude only reads remittance with no recognizable references, and its answer (`hints_json`: periods, products, purpose) narrows matching; amounts must still fit exactly.

## Steps

1. **Who paid:** account or wallet in `payer_identity` (affiliates included), then name, then a quoted client id, then a quoted invoice. Nobody found → `UNIDENTIFIED_CASH` for the accountant.
2. **What it pays** (`payments/match.ts`, pure and unit-tested):
   - the quoted invoices, exactly;
   - quoted invoices short by ≤ $50 → rest booked to bank fees (pol-002);
   - quoted invoices overpaid → excess held as credit (pol-012);
   - otherwise the exact set of open invoices by amount, oldest debt first (wrong or missing references);
   - otherwise a partial payment, oldest first.
3. **No double counting:** cash first covers what billing already applied (`method = 'prior'`). That is also how a second wire for paid invoices is caught as a duplicate (pol-013), and how a returned payment reopens its invoices (pol-015).
4. **Act or ask:** payer known by account or wallet → applied automatically, with an auto-applied work item. Name-only payer, unknown payer, duplicate or an unreferenced partial → work item for a person.
5. **Consequences:** a hold releases when the invoices it secures are paid (pol-011): lever restored, client active, `gateway_command` queued. Open restriction proposals for a client who is no longer overdue are withdrawn.

Pending wires are marked `in_transit`: nobody is restricted while their payment is on the way.

A short payment on an international wire is explained from the wire itself: instructed amount minus intermediary charges equals what arrived.

## Exceptions: the queue for agents

Everything payment checking can't settle on its own is a `work_item` with its evidence in `proposal_json` and the movement's parsed fields: `UNIDENTIFIED_CASH` (unknown payer or wallet), `PAYMENT_MATCH` in `PROPOSED` (name-only payer, unreferenced partial), `REFUND` (duplicate), `UNAPPLIED_CASH`, `BOOKS_BREAK` (tie-out), `SYSTEM_EXCEPTION` (gateway). Agents can investigate these and propose resolutions with `propose_work_item`, or a person approves with `transition_work_item`.

## Data

- `invoice.source_paid_cents`: billing's figure. `paid_cents` and `status` are recomputed from it plus our applications.
- `payment_application.method`: `referenced | exact | split | short_fee | overpaid | partial` for cash, `write_off` for the short amount (pol-002), `prior` for cash billing applied before us. `posted` / `reversal_posted` record what billing has confirmed.
- `client_credit.kind`: `overpayment | unapplied_cash`.
- Approving a `PAYMENT_MATCH` work item (`transition_work_item` → `APPROVED` by ACCOUNTANT or CONTROLLER) applies it, and adds a new bank account to the CRM if one was proposed.

## Checks

```bash
pnpm --filter @access-desk/spacetime test   # matching rules, one test per planted case
pnpm payments:verify                         # live results vs the answer key (fresh database)
pnpm demo:reset                              # bank + database back to Tue Mar 3, roles, full sync
```

Demo wire: `pnpm bank settle WI-5531`, then `POST /sync/now`. Measured: 0.66 s from sync to hold released.
