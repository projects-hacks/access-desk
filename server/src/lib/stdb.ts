// SpacetimeDB connection for the server (gateway and sync).
// After `pnpm stdb:generate`, connect with the generated bindings:
//
//   import { DbConnection } from '../module_bindings';
//   export const db = DbConnection.builder()
//     .withUri(env.STDB_URI)
//     .withDatabaseName(env.STDB_DATABASE)
//     .build();
export {};
