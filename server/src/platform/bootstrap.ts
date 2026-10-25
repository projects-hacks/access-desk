import { tables, type DbConnection } from '../module_bindings';
import type { Dataset } from '../dataset';
import type { Product } from '../domain';
import { GatewayActionSchema } from './commands';
import { PlatformSimulator } from './simulator';

/**
 * Builds the platform as it stands now: dataset baseline, the invoices billing has issued since
 * (the world engine's monthly run; read back from the database), plus every command
 * the gateway has completed, replayed in order. A restart (or a fresh process)
 * gets the same state, and a database reset (no commands) gets the baseline.
 */
export async function openPlatform(conn: DbConnection, ds: Dataset): Promise<PlatformSimulator> {
  await new Promise<void>((resolve) => conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([tables.gatewayCommand, tables.invoice]));
  const sim = new PlatformSimulator(ds);
  // Issued after the dataset's last month: their payments are among the commands replayed below.
  sim.issue([...conn.db.invoice.iter()].filter((i) => !sim.invoices.has(i.id)).map((i) => ({
    id: i.id, clientId: i.clientId, product: i.product as Product, label: i.label, period: i.period, issuedOn: i.issuedOn,
    dueOn: i.dueOn, amountCents: Number(i.amountCents), paidCents: 0, status: 'open' as const,
  })));
  const done = [...conn.db.gatewayCommand.iter()]
    .filter((c) => c.status === 'done' && c.type !== 'REFUND')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const c of done) {
    const action = GatewayActionSchema.parse(JSON.parse(c.actionJson));
    if (action.type !== 'REFUND') sim.apply(String(c.id), action);
  }
  return sim;
}
