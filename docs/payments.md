# Payment checking

Runs inside the SpacetimeDB module (`spacetime/src/reducers/payments.ts`), in the same transaction that records the cash. A payment, its application, any hold release and the audit rows land together, and every screen sees them at once.

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

## Data

- `invoice.source_paid_cents`: billing's figure. `paid_cents` and `status` are recomputed from it plus our applications.
- `payment_application.method`: `referenced | exact | split | short_fee | overpaid | partial | prior | reversal`.
- `client_credit.kind`: `overpayment | unapplied_cash`.
- Approving a `PAYMENT_MATCH` work item (`transition_work_item` → `APPROVED` by ACCOUNTANT or CONTROLLER) applies it, and adds a new bank account to the CRM if one was proposed.

## Checks

```bash
pnpm --filter @access-desk/spacetime test   # matching rules, one test per planted case
pnpm payments:verify                         # live results vs the answer key (fresh database)
pnpm demo:reset                              # bank + database back to Tue Mar 3, roles, full sync
```

Demo wire: `pnpm bank settle WI-5531`, then `POST /sync/now`. Measured: 0.66 s from sync to hold released.
