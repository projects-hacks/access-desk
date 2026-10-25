import { tables, type DbConnection } from '../module_bindings';
import type { Dataset } from '../dataset';
import { disputes, type DisputeRow } from '../dataset/platform-data';
import type { Product } from '../domain';
import { GatewayActionSchema } from './commands';
import { PlatformSimulator } from './simulator';

/**
 * Builds the platform as it stands now: dataset baseline, the invoices billing has issued since
 * (the world engine's monthly run) and live disputes, read back from the database, plus every command
 * the gateway has completed, replayed in order. A restart (or a fresh process)
 * gets the same state, and a database reset (no commands) gets the baseline.
 */
export async function openPlatform(conn: DbConnection, ds: Dataset): Promise<PlatformSimulator> {
  await new Promise<void>((resolve) => conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([tables.gatewayCommand, tables.invoice, tables.dispute]));
  const sim = new PlatformSimulator(ds);
  // Disputes ruled on or opened since the dataset (the world engine's): the dataset's own live ones can be ruled on too.
  const baseline = new Set(disputes(ds).filter((d) => d.status === 'under_review').map((d) => d.id));
  const live: DisputeRow[] = [...conn.db.dispute.iter()]
    .filter((d) => d.id.startsWith('DSP-W') || (baseline.has(d.id) && d.status === 'resolved'))
    .map((d) => ({ ...d, amountCents: Number(d.amountCents), resolvedOn: d.resolvedOn ?? undefined }));
  const credited = new Map<string, number>();
  for (const d of live) if (d.resolution === 'credited') credited.set(d.invoiceId, (credited.get(d.invoiceId) ?? 0) + d.amountCents);
  // Issued after the dataset's last month: their payments are among the commands replayed below.
  // The database holds them after any credit note, so the original amount is put back first.
  sim.issue([...conn.db.invoice.iter()].filter((i) => !sim.invoices.has(i.id)).map((i) => ({
    id: i.id, clientId: i.clientId, product: i.product as Product, label: i.label, period: i.period, issuedOn: i.issuedOn,
    dueOn: i.dueOn, amountCents: Number(i.amountCents) + (credited.get(i.id) ?? 0), paidCents: 0, status: 'open' as const,
  })));
  for (const d of live) sim.loadDispute(d);
  const done = [...conn.db.gatewayCommand.iter()]
    .filter((c) => c.status === 'done' && c.type !== 'REFUND')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const c of done) {
    const action = GatewayActionSchema.parse(JSON.parse(c.actionJson));
    if (action.type !== 'REFUND') sim.apply(String(c.id), action);
  }
  return sim;
}
