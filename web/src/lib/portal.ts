import { useSyncExternalStore } from 'react';
import { DbConnection, tables } from '../module_bindings';
import type {
  AccessLever,
  AccessRequest,
  AssetPrice,
  BankAccount,
  Client,
  CustodyHolding,
  Hold,
  Invoice,
  Notice,
  Permission,
  TradeOrder,
} from '../module_bindings/types';
import { config } from './config';
import { demo } from './demo';

/**
 * The client portal's own connection. Unlike the app-wide controller connection, it
 * subscribes only to the per-identity `my_*` views, so the browser receives one client's
 * rows: whichever client the server bound this identity to (`/demo/portal-as`).
 *
 * Not a second SpacetimeDBProvider: its ConnectionManager keys connections by
 * uri+database and would hand back the controller connection.
 */

const TOKEN_KEY = 'portal-token';

export type PortalSnapshot = {
  /** Connected and the view subscription has been applied. */
  ready: boolean;
  identityHex?: string;
  /** The client this identity is bound to ('' = not bound yet). */
  clientId: string;
  client?: Client;
  invoices: Invoice[];
  holdings: CustodyHolding[];
  levers: AccessLever[];
  permissions: Permission[];
  holds: Hold[];
  accessRequests: AccessRequest[];
  bankAccounts: BankAccount[];
  notices: Notice[];
  orders: TradeOrder[];
  /** Live prices from the public asset_price table. */
  prices: AssetPrice[];
  error?: string;
};

let conn: DbConnection | undefined;
let ready = false;
let error: string | undefined;
let snapshot: PortalSnapshot = read();
const listeners = new Set<() => void>();
let queued = false;

function storedToken(): string | undefined {
  try { return localStorage.getItem(TOKEN_KEY) ?? undefined; } catch { return undefined; }
}

function storeToken(token: string | undefined) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private window */ }
}

function read(): PortalSnapshot {
  const db = conn?.db;
  const client = db ? [...db.myClient.iter()][0] : undefined;
  return {
    ready,
    identityHex: conn?.identity?.toHexString(),
    clientId: client?.id ?? '',
    client,
    invoices: db ? [...db.myInvoices.iter()] : [],
    holdings: db ? [...db.myHoldings.iter()] : [],
    levers: db ? [...db.myLevers.iter()] : [],
    permissions: db ? [...db.myPermissions.iter()] : [],
    holds: db ? [...db.myHolds.iter()] : [],
    accessRequests: db ? [...db.myAccessRequests.iter()] : [],
    bankAccounts: db ? [...db.myBankAccounts.iter()] : [],
    notices: db ? [...db.myNotices.iter()] : [],
    orders: db ? [...db.myOrders.iter()] : [],
    prices: db ? [...db.assetPrice.iter()] : [],
    error,
  };
}

/** Re-read the views once per batch of row events (one transaction fires many). */
function changed() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    snapshot = read();
    for (const l of listeners) l();
  });
}

/** The page's one portal connection, created on first use. */
function connect(): DbConnection {
  if (conn) return conn;
  const saved = storedToken();
  const builder = DbConnection.builder()
    .withUri(config.stdbUri)
    .withDatabaseName(config.stdbDatabase)
    .withAutomaticReconnect()
    .onConnect((c, _identity, token) => {
      // Same token next time = same identity = same binding after a reload.
      storeToken(token);
      error = undefined;
      c.subscriptionBuilder()
        .onApplied(() => {
          ready = true;
          changed();
        })
        .onError((_ctx) => {
          error = 'Portal subscription failed.';
          changed();
        })
        .subscribe([
          tables.myClient,
          tables.myInvoices,
          tables.myHoldings,
          tables.myLevers,
          tables.myPermissions,
          tables.myHolds,
          tables.myAccessRequests,
          tables.myBankAccounts,
          tables.myNotices,
          tables.myOrders,
          tables.assetPrice,
        ]);
      changed();
    })
    .onConnectError((_ctx, e) => {
      // A saved token the server no longer accepts: start fresh on the next load.
      if (saved) storeToken(undefined);
      error = e.message || 'Portal connection failed.';
      changed();
    });
  conn = (saved ? builder.withToken(saved) : builder).build();

  const views = [
    conn.db.myClient,
    conn.db.myInvoices,
    conn.db.myHoldings,
    conn.db.myLevers,
    conn.db.myPermissions,
    conn.db.myHolds,
    conn.db.myAccessRequests,
    conn.db.myBankAccounts,
    conn.db.myNotices,
    conn.db.myOrders,
    conn.db.assetPrice,
  ];
  for (const v of views) {
    v.onInsert(changed);
    v.onDelete(changed);
    // Rows with a primary key change in place: an order going from queued to filled is an update.
    (v as { onUpdate?: (cb: () => void) => void }).onUpdate?.(changed);
  }
  // Dev only: `portalConn.db` in the console shows what this connection actually holds.
  if (import.meta.env.DEV) (window as unknown as { portalConn: DbConnection }).portalConn = conn;
  return conn;
}

function subscribe(listener: () => void) {
  connect();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One client's data, straight from the portal connection's views. */
export function usePortal(): PortalSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Bind this browser's portal identity to a client (demo control); the views refresh by themselves. */
export async function bindTo(clientId: string): Promise<void> {
  const identity = connect().identity?.toHexString();
  if (!identity) throw new Error('Portal connection is not ready yet.');
  await demo('portal-as', { clientId, identity });
}

/**
 * Place an order on the client's own account, as the bound client. The database decides: a refused
 * order still commits (as a trade_order row with the reason), so the answer arrives through my_orders.
 */
export async function placeOrder(clientId: string, side: 'buy' | 'sell', asset: string, amountCents: bigint): Promise<void> {
  await connect().reducers.placeOrder({ clientId, side, asset, amountCents });
}
