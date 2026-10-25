import { env } from './lib/env';
import { buildApp } from './app';
import { connectStdb, connections, downFor } from './lib/stdb';
import { loadDataset } from './dataset';
import { openBank } from './integrations/nessie/bank';
import { Gateway } from './gateway/executor';
import { openPlatform } from './platform/bootstrap';
import { PlatformClient } from './platform/client';
import { Sync } from './sync';
import { demoRoutes } from './demo/routes';
import { buildSeedPlan } from './integrations/nessie/seed-plan';
import { startPriceFeed } from './integrations/prices';

if (!env.SERVER_HOST) {
  console.error('This server runs sync and the gateway on the shared database, and only one may run (the hosted one).\n'
    + 'Use the hosted API (VITE_API_URL). Run one here (pnpm dev:server) only against a database the hosted one does not use.');
  process.exit(1);
}

const ds = loadDataset();
const bank = await openBank();

// Sync and the gateway each act under their own identity and role.
const { conn: syncConn } = await connectStdb(env.STDB_TOKEN, 'sync');
const platform = await openPlatform(syncConn, ds);
const app = buildApp(platform);
const log = (msg: string) => app.log.info(msg);

const sync = new Sync(syncConn, bank, ds, platform, log);
await sync.ready();

/** Pull the bank now (called right after a demo wire is settled). */
app.post('/sync/now', async () => {
  const results = await sync.cash();
  return results.map(({ source, written, errors }) => ({ source, written, errors }));
});

let gateway: Gateway | undefined;
if (env.DEMO_CONTROLS) {
  if (!env.STDB_DEMO_TOKEN) throw new Error('DEMO_CONTROLS=true needs STDB_DEMO_TOKEN (role DEMO)');
  const { conn: demoConn } = await connectStdb(env.STDB_DEMO_TOKEN, 'demo');
  await app.register(demoRoutes, { conn: demoConn, sync, gateway: () => gateway, bank, plan: buildSeedPlan(ds), ds, platform });
}

// Routes are registered above; the gateway below calls the platform API on this server, so listen first.
await app.listen({ port: env.PORT, host: '0.0.0.0' });

if (env.STDB_GATEWAY_TOKEN) {
  const { conn: gatewayConn } = await connectStdb(env.STDB_GATEWAY_TOKEN, 'gateway');
  gateway = new Gateway(gatewayConn, new PlatformClient(env.PLATFORM_API_URL ?? `http://127.0.0.1:${env.PORT}/platform`), bank, ds, (accounts) => sync.cash(accounts), log);
  await gateway.ready();
  gateway.start();
} else {
  app.log.warn('STDB_GATEWAY_TOKEN not set: gateway disabled, commands will queue');
}
sync.start();
startPriceFeed(syncConn, platform, log);

// Reconnects are automatic. A connection down for two minutes means something is wrong
// that a fresh process fixes (the platform replays from the database on boot): exit and
// let the host restart us.
setInterval(() => {
  const stuck = downFor(120_000);
  if (stuck.length) {
    app.log.error(`SpacetimeDB down for 2 minutes (${stuck.map((c) => c.name).join(', ')}): exiting so the host restarts the server`);
    process.exit(1);
  }
}, 15_000);
