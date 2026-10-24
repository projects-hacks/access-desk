import type { DbConnection } from '../../module_bindings';
import type { CashMovement, MetricSnapshot, Precedent } from '../../module_bindings/types';
import type { Dataset } from '../../dataset';
import { achCollection, invoiceRemittance, wireIn } from '../../integrations/bank-text/format';
import { parseBankText } from '../../integrations/bank-text/parse';
import type { SeedMap } from '../../integrations/nessie/seed-map';
import type { SyncRecord } from '../writer';

/**
 * Twelve months before the bank window, from the platform's records: payments
 * billing already applied, past decisions and their outcomes, weekly metrics.
 */
export function historyRecords(conn: DbConnection, ds: Dataset, bank: SeedMap): SyncRecord<unknown>[] {
  const r = conn.reducers;
  const records: SyncRecord<unknown>[] = [];
  const clients = new Map(ds.clients.map((c) => [c.id, c]));
  const wallets = new Map(ds.onchain.filter((p) => p.clientId).map((p) => [p.clientId!, p.wallet]));

  for (const p of ds.history.cash) {
    const client = clients.get(p.clientId);
    if (!client) throw new Error(`history ${p.id}: unknown client ${p.clientId}`);
    const usdc = p.rail === 'USDC';
    const account = usdc ? wallets.get(p.clientId) : bank.accounts[p.clientId]?.number;
    if (!account) throw new Error(`history ${p.id}: no ${usdc ? 'wallet' : 'bank account'} for ${p.clientId}`);
    // Same bank text as live cash, read back by the same parser, so history and live data look alike.
    const remittance = invoiceRemittance(p.refs, 'spaced');
    const memo = usdc
      ? `USDC TRANSFER IN NETWORK:BASE TX:${p.id} FROM:${account} TRAVEL RULE ORIG:${client.legalName.toUpperCase()} PMT DET:${remittance}`
      : p.rail === 'ACH'
        ? achCollection({ trace: p.id, company: client.legalName, account, individualId: client.id.replace('-', ''), addenda: remittance })
        : wireIn({ trn: p.id, date: p.valueDate, orig: client.legalName, origAccount: account, bank: client.bank, remittance });
    const parsed = usdc ? undefined : parseBankText(memo);
    const row: CashMovement = {
      id: `history:${p.id}`,
      source: 'history',
      platformAccount: usdc ? 'wallet' : 'collections',
      direction: 'in',
      rail: p.rail,
      amountCents: BigInt(p.amountCents),
      valueOn: p.valueDate,
      status: 'posted',
      memo,
      category: usdc ? 'usdc_in' : parsed!.category,
      network: usdc ? 'USDC' : parsed!.network,
      origName: parsed?.counterpartyName ?? client.legalName.toUpperCase(),
      origAccount: account,
      remittance,
      refs: p.refs,
      bankRef: p.id,
      reverses: undefined,
      instructedCents: undefined,
      chargesCents: undefined,
      chargeBearer: undefined,
      returnCode: undefined,
      parsedBy: 'rules',
      parseConfidence: parsed?.confidence ?? 1,
      parseNotes: parsed?.notes.join('; ') ?? '',
      hintsJson: '',
      rawId: `history:${p.id}`,
      matchStatus: 'unmatched',
      isHistory: true,
    };
    records.push({ table: 'cash_movement', id: row.id, row, payload: p, rawId: row.rawId, upsert: (x: CashMovement) => r.upsertCashMovement({ row: x }) } as SyncRecord<unknown>);
  }

  for (const p of ds.history.precedents) {
    const row: Precedent = { ...p, workItemId: undefined, source: 'history' };
    records.push({ table: 'precedent', id: p.id, row, upsert: (x: Precedent) => r.upsertPrecedent({ row: x }) } as SyncRecord<unknown>);
  }

  for (const m of ds.history.metrics) {
    const row: MetricSnapshot = m;
    records.push({ table: 'metric_snapshot', id: m.id, row, upsert: (x: MetricSnapshot) => r.upsertMetricSnapshot({ row: x }) } as SyncRecord<unknown>);
  }
  return records;
}
