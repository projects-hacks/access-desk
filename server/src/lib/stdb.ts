import { DbConnection } from '../module_bindings';
import { env } from './env';

/**
 * Connects to the shared SpacetimeDB database on Maincloud.
 * Resolves once connected; `token` is the identity to save as STDB_TOKEN.
 */
export function connectStdb(token = env.STDB_TOKEN): Promise<{ conn: DbConnection; token: string }> {
  return new Promise((resolve, reject) => {
    const builder = DbConnection.builder()
      .withUri(env.STDB_URI)
      .withDatabaseName(env.STDB_DATABASE)
      .onConnect((conn, _identity, token) => resolve({ conn, token }))
      .onConnectError((_ctx, err) => reject(err));
    (token ? builder.withToken(token) : builder).build();
  });
}
