export const config = {
  stdbUri: import.meta.env.VITE_STDB_URI ?? 'ws://localhost:3000',
  stdbDatabase: import.meta.env.VITE_STDB_DATABASE ?? 'access-desk',
  apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:4000',
};
// TODO: after `pnpm stdb:generate`, wrap <App /> in SpacetimeDBProvider
// (spacetimedb/react) using ./module_bindings, then read tables with useTable().
