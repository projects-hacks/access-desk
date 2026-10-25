/**
 * Checks client portal privacy on the shared database: a bound identity sees
 * only its client's rows through the my_* views, rebinding switches clients,
 * an unbound identity sees nothing, and staff identities can't be bound.
 * Usage: pnpm portal:verify  (after publishing the module with the portal views)
 */
import { env } from '../lib/env';
import { connectStdb } from '../lib/stdb';
import type { DbConnection } from '../module_bindings';

const KESTREL = 'ORG-90412';
const BLUEFIN = 'ORG-90233';

if (!env.STDB_DEMO_TOKEN) throw new Error('needs STDB_DEMO_TOKEN in .env');
const identityOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).hex_identity as string;

const VIEWS = [
  'my_client', 'my_invoices', 'my_holdings', 'my_levers', 'my_permissions', 'my_holds', 'my_access_requests', 'my_bank_accounts', 'my_notices',
];

let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? 'ok ' : 'BAD'} ${label}${!ok && detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const refused = async (call: Promise<unknown>, expect: RegExp) => {
  try {
    await call;
    return 'accepted';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return expect.test(msg) ? true : msg;
  }
};
const subscribe = (conn: DbConnection) => new Promise<void>((resolve, reject) =>
  conn.subscriptionBuilder().onApplied(() => resolve()).onError((ctx) => reject(ctx.event ?? new Error('subscription failed')))
    .subscribe(VIEWS.map((v) => `SELECT * FROM ${v}`)));

/** Every row the portal views hold, tagged with the client it belongs to. */
const rows = (conn: DbConnection) => {
  const db = conn.db;
  return {
    client: [...db.myClient.iter()].map((r) => r.id),
    invoices: [...db.myInvoices.iter()].map((r) => r.clientId),
    holdings: [...db.myHoldings.iter()].map((r) => r.clientId),
    levers: [...db.myLevers.iter()].map((r) => r.clientId),
    permissions: [...db.myPermissions.iter()].map((r) => r.clientId),
    holds: [...db.myHolds.iter()].map((r) => r.clientId),
    accessRequests: [...db.myAccessRequests.iter()].map((r) => r.clientId),
    bankAccounts: [...db.myBankAccounts.iter()].map((r) => r.owner),
    notices: [...db.myNotices.iter()].map((r) => r.clientId),
  };
};
const total = (conn: DbConnection) => Object.values(rows(conn)).reduce((n, ids) => n + ids.length, 0);
const foreign = (conn: DbConnection, clientId: string) =>
  Object.entries(rows(conn)).flatMap(([view, ids]) => ids.filter((id) => id !== clientId).map((id) => `${view}:${id}`));

/** Waits until the views show only `clientId`'s rows, with at least one invoice. */
const until = async (conn: DbConnection, clientId: string, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (rows(conn).invoices.length > 0 && foreign(conn, clientId).length === 0) return;
    await wait(100);
  }
};

const assertOnly = (conn: DbConnection, clientId: string) => {
  const r = rows(conn);
  const others = foreign(conn, clientId);
  check(r.client.length === 1 && r.client[0] === clientId, `my_client is ${clientId}`, r.client.join(','));
  check(r.invoices.length > 0, `my_invoices non-empty for ${clientId}`, `${r.invoices.length}`);
  check(others.length === 0, `every row belongs to ${clientId}`, others.slice(0, 5).join(', '));
  console.log(`      ${Object.entries(r).map(([k, v]) => `${k}=${v.length}`).join(' ')}`);
};

const { conn: demo } = await connectStdb(env.STDB_DEMO_TOKEN, 'demo');
const { conn: portal } = await connectStdb('', 'portal');
const portalHex = portal.identity!.toHexString();
console.log(`Portal identity ${portalHex.slice(0, 12)}…`);
await subscribe(portal);
check(total(portal) === 0, 'Before binding: portal sees nothing', `${total(portal)} rows`);

console.log(`\nBound to ${KESTREL}`);
await demo.reducers.bindPortal({ identityHex: portalHex, clientId: KESTREL });
await until(portal, KESTREL);
assertOnly(portal, KESTREL);

console.log(`\nRebound to ${BLUEFIN}`);
await demo.reducers.bindPortal({ identityHex: portalHex, clientId: BLUEFIN });
await until(portal, BLUEFIN);
assertOnly(portal, BLUEFIN);

console.log('\nUnbound identity');
const { conn: stranger } = await connectStdb('', 'stranger');
await subscribe(stranger);
await wait(500);
check(total(stranger) === 0, 'Fresh anonymous connection sees zero rows', `${total(stranger)} rows`);

console.log('\nRefusals');
const controllerToken = process.env.VITE_STDB_CONTROLLER_TOKEN;
if (controllerToken) {
  const r = await refused(demo.reducers.bindPortal({ identityHex: identityOf(controllerToken), clientId: KESTREL }), /already has role/);
  check(r === true, 'Controller identity refused (staff role kept)', String(r));
} else {
  console.log('  skip controller: no VITE_STDB_CONTROLLER_TOKEN in .env');
}
let r = await refused(demo.reducers.bindPortal({ identityHex: demo.identity!.toHexString(), clientId: KESTREL }), /already has role/);
check(r === true, 'Demo service identity refused (service role kept)', String(r));
r = await refused(demo.reducers.bindPortal({ identityHex: stranger.identity!.toHexString(), clientId: 'ORG-00000' }), /unknown client/);
check(r === true, 'Unknown client refused', String(r));
r = await refused(portal.reducers.bindPortal({ identityHex: stranger.identity!.toHexString(), clientId: KESTREL }), /requires one of/);
check(r === true, 'A CLIENT identity cannot bind anyone', String(r));

for (const c of [demo, portal, stranger]) c.disconnect();
console.log(failed ? `\nFAILED: ${failed} checks` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
