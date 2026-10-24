/**
 * One full sync pass into the shared database, then the gateway drains its
 * queue (in process), then exit. Usage: pnpm sync
 */
import { loadDataset } from '../dataset';
import { Gateway } from '../gateway/executor';
import { openBank } from '../integrations/nessie/bank';
import { env } from '../lib/env';
import { connectStdb } from '../lib/stdb';
import { openPlatform } from '../platform/bootstrap';
import { LocalPlatform } from '../platform/client';
import { Sync } from '../sync';

const ds = loadDataset();
const bank = await openBank();
const { conn } = await connectStdb(env.STDB_TOKEN);
const platform = await openPlatform(conn, ds);
const sync = new Sync(conn, bank, ds, platform);
await sync.ready();
console.log(`Syncing into sim date ${sync.simDate()} (bank: ${bank.mode}, run ${bank.map.run})`);
const results = await sync.full();
results.forEach((r) => sync.report(r));
let failed = results.some((r) => r.errors.length);

if (env.STDB_GATEWAY_TOKEN) {
  const { conn: gwConn } = await connectStdb(env.STDB_GATEWAY_TOKEN);
  const gateway = new Gateway(gwConn, new LocalPlatform(platform), bank, ds, (accounts) => sync.cash(accounts));
  await gateway.ready();
  const ran = await gateway.drain();
  const left = gateway.pending();
  console.log(`[gateway] executed ${ran} commands, ${left} still pending`);
  if (left) failed = true;
  gwConn.disconnect();
} else {
  console.log('[gateway] STDB_GATEWAY_TOKEN not set: commands left queued');
}
conn.disconnect();
process.exit(failed ? 1 : 0);
