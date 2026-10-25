import { DbConnection } from './module_bindings';
import { env } from './env';

/**
 * One connection for all four agents. The whole world is subscribed, so every agent reads the
 * live client-side cache (conn.db.<table>) instead of querying: a commit is pushed here before
 * the task it queued is.
 */
export function connect(): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    let ready = false;
    const builder = DbConnection.builder()
      .withUri(env.STDB_URI)
      .withDatabaseName(env.STDB_DATABASE)
      .withAutomaticReconnect()
      .onConnect((conn) => {
        conn.subscriptionBuilder()
          .onApplied(() => {
            if (!ready) resolve(conn);
            ready = true;
          })
          .onError((ctx) => (ready ? console.error(`[agents] subscription error: ${ctx.event}`) : reject(ctx.event)))
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => reject(err))
      .onDisconnect((_ctx, err, next, delayMs) =>
        console.warn(`[agents] disconnected${err ? `: ${err.message}` : ''}${next ? ` · retry #${next} in ${delayMs} ms` : ''}`))
      .onAutomaticReconnect(() => console.log('[agents] reconnected'));
    (env.STDB_AGENT_TOKEN ? builder.withToken(env.STDB_AGENT_TOKEN) : builder).build();
  });
}
