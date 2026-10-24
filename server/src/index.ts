import { env } from './lib/env';
import { buildApp } from './app';
import { connectStdb } from './lib/stdb';
import { loadDataset } from './dataset';
import { openBank } from './integrations/nessie/bank';
import { Sync } from './sync';

const app = buildApp();
const { conn } = await connectStdb();
const sync = new Sync(conn, await openBank(), loadDataset(), (msg) => app.log.info(msg));
await sync.ready();
sync.start();

/** Pull the bank now (called right after a demo wire is settled). */
app.post('/sync/now', async () => {
  const results = await sync.cash();
  return results.map(({ source, written, errors }) => ({ source, written, errors }));
});

await app.listen({ port: env.PORT, host: '0.0.0.0' });
