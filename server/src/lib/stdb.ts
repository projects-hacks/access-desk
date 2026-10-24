import { DbConnection } from '../module_bindings';
import { env } from './env';

interface Tracked {
  name: string;
  conn: DbConnection;
  /** When the socket dropped; cleared when the SDK reconnects. */
  downSince?: number;
}

/** Every connection this process opened, for /health and the watchdog. */
export const connections: Tracked[] = [];

/**
 * Connects to the shared SpacetimeDB database on Maincloud. Resolves once
 * connected; `token` is the identity to save as STDB_TOKEN. A dropped socket
 * reconnects on its own (backoff 1 s to 30 s) and resumes the session, so
 * subscriptions and their callbacks keep working.
 */
export function connectStdb(token = env.STDB_TOKEN, name = 'stdb'): Promise<{ conn: DbConnection; token: string }> {
  return new Promise((resolve, reject) => {
    let entry: Tracked | undefined;
    const builder = DbConnection.builder()
      .withUri(env.STDB_URI)
      .withDatabaseName(env.STDB_DATABASE)
      .withAutomaticReconnect()
      .onConnect((conn, _identity, token) => {
        entry = { name, conn };
        connections.push(entry);
        resolve({ conn, token });
      })
      // Only the first attempt reports here; later failures are retried and reported via onDisconnect.
      .onConnectError((_ctx, err) => reject(err))
      .onDisconnect((_ctx, err, nextAttempt, delayMs) => {
        if (entry) entry.downSince ??= Date.now();
        console.warn(`[stdb:${name}] disconnected${err ? `: ${err.message}` : ''}${nextAttempt ? ` · retry #${nextAttempt} in ${delayMs} ms` : ' · not retrying'}`);
      })
      .onAutomaticReconnect(() => {
        if (entry) entry.downSince = undefined;
        console.log(`[stdb:${name}] reconnected`);
      });
    (token ? builder.withToken(token) : builder).build();
  });
}

/** Connections down longer than `ms` (or that never came back). */
export function downFor(ms: number, now = Date.now()) {
  return connections.filter((c) => c.downSince !== undefined && now - c.downSince > ms);
}
