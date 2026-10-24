import { t } from 'spacetimedb/server';
import { audit, requireRole } from '../context';
import { CAN_SYNC } from '../roles';
import { spacetimedb } from '../schema';
import { accessLever, capability, client, contract, contractClause, payerIdentity } from '../tables/clients';
import { assetPrice, custodyHolding, loan, owedToClient, position } from '../tables/assets';
import { bankAccount, cashMovement, dispute, invoice, ledgerEntry } from '../tables/money';
import { rawRecord, syncSource } from '../tables/sync';
import { metricSnapshot, precedent } from '../tables/learning';
import { recomputeInvoice } from '../payments/apply';
import { startCure } from '../payments/deadlines';
import { onCashMovement, onCashRemoved } from './payments';

// Sync writes golden rows from systems of record. Every reducer is an idempotent upsert by primary key.

export const setSyncStatus = spacetimedb.reducer({ row: syncSource.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (ctx.db.syncSource.source.find(row.source)) ctx.db.syncSource.source.update(row);
  else ctx.db.syncSource.insert(row);
});

export const upsertRawRecord = spacetimedb.reducer({ row: rawRecord.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  const existing = ctx.db.rawRecord.id.find(row.id);
  if (existing) ctx.db.rawRecord.id.update({ ...row, firstSeenAt: existing.firstSeenAt });
  else ctx.db.rawRecord.insert(row);
});

// Fields the system of work owns (client status, lever state, borrowing, match status, paid amounts)
// are taken from the source on first import only; later syncs never overwrite our decisions.

export const upsertClient = spacetimedb.reducer({ row: client.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  const existing = ctx.db.client.id.find(row.id);
  if (existing) ctx.db.client.id.update({ ...row, status: existing.status });
  else ctx.db.client.insert(row);
});

export const upsertPayerIdentity = spacetimedb.reducer({ row: payerIdentity.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (ctx.db.payerIdentity.id.find(row.id)) ctx.db.payerIdentity.id.update(row);
  else ctx.db.payerIdentity.insert(row);
});

export const upsertContract = spacetimedb.reducer({ row: contract.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (ctx.db.contract.clientId.find(row.clientId)) ctx.db.contract.clientId.update(row);
  else ctx.db.contract.insert(row);
});

export const upsertContractClause = spacetimedb.reducer({ row: contractClause.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (ctx.db.contractClause.id.find(row.id)) ctx.db.contractClause.id.update(row);
  else ctx.db.contractClause.insert(row);
});

export const upsertCapability = spacetimedb.reducer({ row: capability.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (ctx.db.capability.id.find(row.id)) ctx.db.capability.id.update(row);
  else ctx.db.capability.insert(row);
});

/** Initial lever states come from the platform's admin console; afterwards only the gateway changes them. */
export const upsertAccessLever = spacetimedb.reducer({ row: accessLever.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (!ctx.db.accessLever.id.find(row.id)) ctx.db.accessLever.insert(row);
});

/** Billing's view of an invoice; paid amount and status are then recomputed with our applications. */
export const upsertInvoice = spacetimedb.reducer({ row: invoice.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  const existing = ctx.db.invoice.id.find(row.id);
  // Keep the paid date we recorded when billing doesn't have one yet.
  if (existing) ctx.db.invoice.id.update({ ...row, paidOn: row.paidOn ?? existing.paidOn });
  else ctx.db.invoice.insert(row);
  recomputeInvoice(ctx, row.id);
});

export const upsertDispute = spacetimedb.reducer({ row: dispute.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (ctx.db.dispute.id.find(row.id)) ctx.db.dispute.id.update(row);
  else ctx.db.dispute.insert(row);
  recomputeInvoice(ctx, row.invoiceId);
});

/**
 * New or changed cash. Matching state is ours, so a re-read never overwrites it.
 * Payment checking runs in this same transaction.
 */
export const upsertCashMovement = spacetimedb.reducer({ row: cashMovement.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  const existing = ctx.db.cashMovement.id.find(row.id);
  const next = existing ? { ...row, matchStatus: existing.matchStatus } : row;
  if (existing) ctx.db.cashMovement.id.update(next);
  else ctx.db.cashMovement.insert(next);
  if (!existing || existing.status !== row.status) {
    audit(ctx, {
      action: existing ? 'CASH_STATUS_CHANGED' : 'CASH_RECEIVED',
      subjectType: 'cash_movement',
      subjectId: row.id,
      fromState: existing?.status,
      toState: row.status,
      detail: `${row.direction} ${row.rail} ${row.amountCents} ${row.origName}`,
    });
  }
  onCashMovement(ctx, next, existing ?? undefined);
});

export const upsertCustodyHolding = spacetimedb.reducer({ row: custodyHolding.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (ctx.db.custodyHolding.id.find(row.id)) ctx.db.custodyHolding.id.update(row);
  else ctx.db.custodyHolding.insert(row);
});

export const upsertAssetPrice = spacetimedb.reducer({ row: assetPrice.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (ctx.db.assetPrice.asset.find(row.asset)) ctx.db.assetPrice.asset.update(row);
  else ctx.db.assetPrice.insert(row);
});

/** Bank balances computed from the Nessie statement. */
export const upsertBankAccount = spacetimedb.reducer({ row: bankAccount.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (ctx.db.bankAccount.id.find(row.id)) ctx.db.bankAccount.id.update(row);
  else ctx.db.bankAccount.insert(row);
});

/** A notice the platform's messaging system already sent. A default notice starts the cure period from its date. */
export const upsertNotice = spacetimedb.reducer(
  { ref: t.string(), clientId: t.string(), channel: t.string(), body: t.string(), sentOn: t.string() },
  (ctx, { ref, clientId, channel, body, sentOn }) => {
    requireRole(ctx, CAN_SYNC);
    if ([...ctx.db.notice.ref.filter(ref)].length) return;
    ctx.db.notice.insert({ id: 0n, clientId, workItemId: undefined, channel, body, status: 'sent', sentOn, ref, sentAt: undefined });
    if (channel !== 'rm') startCure(ctx, clientId, sentOn);
  },
);

export const upsertOwedToClient = spacetimedb.reducer({ row: owedToClient.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (ctx.db.owedToClient.id.find(row.id)) ctx.db.owedToClient.id.update(row);
  else ctx.db.owedToClient.insert(row);
});

export const upsertPosition = spacetimedb.reducer({ row: position.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  if (ctx.db.position.id.find(row.id)) ctx.db.position.id.update(row);
  else ctx.db.position.insert(row);
});

export const upsertLoan = spacetimedb.reducer({ row: loan.rowType }, (ctx, { row }) => {
  requireRole(ctx, CAN_SYNC);
  const existing = ctx.db.loan.id.find(row.id);
  if (existing) ctx.db.loan.id.update({ ...row, borrowingAllowed: existing.borrowingAllowed });
  else ctx.db.loan.insert(row);
});

/** General ledger lines, in batches (thousands of lines; one call each would be slow). */
export const upsertLedgerEntries = spacetimedb.reducer({ rows: t.array(ledgerEntry.rowType) }, (ctx, { rows }) => {
  requireRole(ctx, CAN_SYNC);
  for (const row of rows) {
    if (ctx.db.ledgerEntry.id.find(row.id)) ctx.db.ledgerEntry.id.update(row);
    else ctx.db.ledgerEntry.insert(row);
  }
});

/** Past decisions (history import) and live ones written by agents. */
export const upsertPrecedent = spacetimedb.reducer({ row: precedent.rowType }, (ctx, { row }) => {
  requireRole(ctx, ['SYNC', 'AGENT', 'ADMIN']);
  if (ctx.db.precedent.id.find(row.id)) ctx.db.precedent.id.update(row);
  else ctx.db.precedent.insert(row);
});

export const upsertMetricSnapshot = spacetimedb.reducer({ row: metricSnapshot.rowType }, (ctx, { row }) => {
  requireRole(ctx, ['SYNC', 'AGENT', 'ADMIN']);
  if (ctx.db.metricSnapshot.id.find(row.id)) ctx.db.metricSnapshot.id.update(row);
  else ctx.db.metricSnapshot.insert(row);
});

/** Cash that disappeared from the source (bank reset, or dated after the clock was moved back). */
export const removeCashMovement = spacetimedb.reducer({ id: t.string() }, (ctx, { id }) => {
  requireRole(ctx, CAN_SYNC);
  const existing = ctx.db.cashMovement.id.find(id);
  if (!existing) return;
  onCashRemoved(ctx, existing);
  ctx.db.cashMovement.id.delete(id);
  audit(ctx, { action: 'CASH_REMOVED', subjectType: 'cash_movement', subjectId: id, fromState: existing.status, detail: existing.bankRef });
});

/** Marks a sync pass as finished (keeps the reducer list honest about who wrote what). */
export const recordSyncError = spacetimedb.reducer({ source: t.string(), error: t.string() }, (ctx, { source, error }) => {
  requireRole(ctx, CAN_SYNC);
  const row = ctx.db.syncSource.source.find(source);
  if (row) ctx.db.syncSource.source.update({ ...row, status: 'error', error });
});
