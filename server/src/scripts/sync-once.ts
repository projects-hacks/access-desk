/** One full sync pass into the shared database, then exit. Usage: pnpm sync */
import { loadDataset } from '../dataset';
import { openBank } from '../integrations/nessie/bank';
import { connectStdb } from '../lib/stdb';
import { Sync } from '../sync';

const { conn } = await connectStdb();
const bank = await openBank();
const sync = new Sync(conn, bank, loadDataset());
await sync.ready();
console.log(`Syncing into sim date ${sync.simDate()} (bank: ${bank.mode}, run ${bank.map.run})`);
const results = await sync.full();
results.forEach((r) => sync.report(r));
const failed = results.some((r) => r.errors.length);
conn.disconnect();
process.exit(failed ? 1 : 0);
