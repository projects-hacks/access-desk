import { env } from './lib/env';
import { buildApp } from './app';
import { connectStdb } from './lib/stdb';
import { loadDataset } from './dataset';
import { openBank } from './integrations/nessie/bank';
import { Gateway } from './gateway/executor';
import { openPlatform } from './platform/bootstrap';
import { PlatformClient } from './platform/client';
import { Sync } from './sync';

const ds = loadDataset();
const bank = await openBank();

// Sync and the gateway each act under their own identity and role.
const { conn: syncConn } = await connectStdb(env.STDB_TOKEN);
const platform = await openPlatform(syncConn, ds);
const app = buildApp(platform);
const log = (msg: string) => app.log.info(msg);

const sync = new Sync(syncConn, bank, ds, platform, log);
await sync.ready();

await app.listen({ port: env.PORT, host: '0.0.0.0' });

if (env.STDB_GATEWAY_TOKEN) {
  const { conn: gatewayConn } = await connectStdb(env.STDB_GATEWAY_TOKEN);
  const gateway = new Gateway(gatewayConn, new PlatformClient(env.PLATFORM_API_URL ?? `http://127.0.0.1:${env.PORT}/platform`), bank, ds, () => sync.cash(), log);
  await gateway.ready();
  gateway.start();
} else {
  app.log.warn('STDB_GATEWAY_TOKEN not set: gateway disabled, commands will queue');
}
sync.start();

/** Pull the bank now (called right after a demo wire is settled). */
app.post('/sync/now', async () => {
  const results = await sync.cash();
  return results.map(({ source, written, errors }) => ({ source, written, errors }));
});
