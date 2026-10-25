import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { App } from './App';
import { config } from './lib/config';
import { DbConnection } from './module_bindings';
import './styles.css';

// Reads need no token; approvals run as the controller (see lib/config).
// A dropped connection (a module publish disconnects everyone) comes back as a fresh page: the new
// build's bindings and every table subscribed again, instead of a screen with half its tables empty.
// A connection torn down at once (React's dev double mount) is not a drop.
let reloading = false;
let connectedAt = 0;
const reloadIn = (ms: number) => {
  if (reloading) return;
  reloading = true;
  setTimeout(() => window.location.reload(), ms);
};
const builder = DbConnection.builder()
  .withUri(config.stdbUri)
  .withDatabaseName(config.stdbDatabase)
  .onConnect(() => {
    connectedAt = Date.now();
  })
  .onDisconnect(() => {
    if (connectedAt && Date.now() - connectedAt > 5_000) reloadIn(3_000);
  })
  .onConnectError(() => reloadIn(10_000));
const connectionBuilder = config.stdbToken ? builder.withToken(config.stdbToken) : builder;

// Demo controls (inject, settle, advance, withdraw, reset) are POSTs to `${apiUrl}/demo/*`.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  </StrictMode>,
);
