import { tables, type DbConnection } from '../module_bindings';
import type { Dataset } from '../dataset';
import { GatewayActionSchema } from './commands';
import { PlatformSimulator } from './simulator';

/**
 * Builds the platform as it stands now: dataset baseline plus every command
 * the gateway has completed, replayed in order. A restart (or a fresh process)
 * gets the same state, and a database reset (no commands) gets the baseline.
 */
export async function openPlatform(conn: DbConnection, ds: Dataset): Promise<PlatformSimulator> {
  await new Promise<void>((resolve) => conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([tables.gatewayCommand]));
  const sim = new PlatformSimulator(ds);
  const done = [...conn.db.gatewayCommand.iter()]
    .filter((c) => c.status === 'done' && c.type !== 'REFUND')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const c of done) {
    const action = GatewayActionSchema.parse(JSON.parse(c.actionJson));
    if (action.type !== 'REFUND') sim.apply(String(c.id), action);
  }
  return sim;
}
