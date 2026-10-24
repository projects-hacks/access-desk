export const config = {
  stdbUri: import.meta.env.VITE_STDB_URI ?? 'wss://maincloud.spacetimedb.com',
  stdbDatabase: import.meta.env.VITE_STDB_DATABASE ?? 'access-desk-calhacks13',
  apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:4000',
  /** Controller identity: needed to approve or reject work items. Reads work without it. */
  stdbToken: import.meta.env.VITE_STDB_CONTROLLER_TOKEN as string | undefined,
  /** Sent as x-demo-key on demo POSTs to the hosted API. */
  demoKey: import.meta.env.VITE_DEMO_KEY as string | undefined,
};
