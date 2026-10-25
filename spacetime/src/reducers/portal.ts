import { Identity } from 'spacetimedb';
import { SenderError, t, type ViewCtx } from 'spacetimedb/server';
import { audit, requireRole } from '../context';
import { spacetimedb } from '../schema';
import { custodyHolding, hold } from '../tables/assets';
import { accessLever, client, permission } from '../tables/clients';
import { bankAccount, invoice } from '../tables/money';
import { tradeOrder } from '../tables/orders';
import { accessRequest, notice } from '../tables/work';

type PortalCtx = ViewCtx<(typeof spacetimedb)['schemaType']>;

/** The client the caller is bound to as a CLIENT, or undefined for everyone else. */
function myClientId(ctx: PortalCtx): string | undefined {
  const me = ctx.db.actor.identity.find(ctx.sender);
  return me?.role === 'CLIENT' && me.clientId ? me.clientId : undefined;
}

// Client portal views: each caller sees only the rows of the client it is bound to.

export const myClient = spacetimedb.view({ name: 'my_client', public: true }, t.option(client.rowType), (ctx) => {
  const id = myClientId(ctx);
  return (id && ctx.db.client.id.find(id)) || undefined;
});

export const myInvoices = spacetimedb.view({ name: 'my_invoices', public: true }, t.array(invoice.rowType), (ctx) => {
  const id = myClientId(ctx);
  return id ? [...ctx.db.invoice.clientId.filter(id)] : [];
});

export const myHoldings = spacetimedb.view({ name: 'my_holdings', public: true }, t.array(custodyHolding.rowType), (ctx) => {
  const id = myClientId(ctx);
  return id ? [...ctx.db.custodyHolding.clientId.filter(id)] : [];
});

export const myLevers = spacetimedb.view({ name: 'my_levers', public: true }, t.array(accessLever.rowType), (ctx) => {
  const id = myClientId(ctx);
  return id ? [...ctx.db.accessLever.clientId.filter(id)] : [];
});

export const myPermissions = spacetimedb.view({ name: 'my_permissions', public: true }, t.array(permission.rowType), (ctx) => {
  const id = myClientId(ctx);
  return id ? [...ctx.db.permission.clientId.filter(id)] : [];
});

export const myHolds = spacetimedb.view({ name: 'my_holds', public: true }, t.array(hold.rowType), (ctx) => {
  const id = myClientId(ctx);
  return id ? [...ctx.db.hold.clientId.filter(id)] : [];
});

export const myAccessRequests = spacetimedb.view({ name: 'my_access_requests', public: true }, t.array(accessRequest.rowType), (ctx) => {
  const id = myClientId(ctx);
  return id ? [...ctx.db.accessRequest.clientId.filter(id)] : [];
});

/** bank_account is keyed by `owner` (the client id, or platform). */
export const myBankAccounts = spacetimedb.view({ name: 'my_bank_accounts', public: true }, t.array(bankAccount.rowType), (ctx) => {
  const id = myClientId(ctx);
  return id ? [...ctx.db.bankAccount.owner.filter(id)] : [];
});

export const myNotices = spacetimedb.view({ name: 'my_notices', public: true }, t.array(notice.rowType), (ctx) => {
  const id = myClientId(ctx);
  return id ? [...ctx.db.notice.clientId.filter(id)] : [];
});

export const myOrders = spacetimedb.view({ name: 'my_orders', public: true }, t.array(tradeOrder.rowType), (ctx) => {
  const id = myClientId(ctx);
  return id ? [...ctx.db.tradeOrder.clientId.filter(id)] : [];
});

/** Binds a browser identity to one client so the portal views return that client's rows. Never touches staff or service identities. */
export const bindPortal = spacetimedb.reducer(
  { identityHex: t.string(), clientId: t.string() },
  (ctx, { identityHex, clientId }) => {
    requireRole(ctx, ['DEMO', 'ADMIN']);
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(identityHex)) throw new SenderError('identityHex must be a 64-char hex identity');
    if (!ctx.db.client.id.find(clientId)) throw new SenderError(`unknown client ${clientId}`);
    const identity = Identity.fromString(identityHex);
    const existing = ctx.db.actor.identity.find(identity);
    if (existing && existing.role !== 'CLIENT') throw new SenderError(`identity already has role ${existing.role}; only portal identities can be bound`);
    const row = { identity, name: 'Client portal', role: 'CLIENT', clientId };
    if (existing) ctx.db.actor.identity.update(row);
    else ctx.db.actor.insert(row);
    audit(ctx, {
      action: 'BIND_PORTAL', subjectType: 'actor', subjectId: identityHex, clientId,
      fromState: existing?.clientId ?? '', toState: clientId, detail: 'Client portal',
    });
  },
);
