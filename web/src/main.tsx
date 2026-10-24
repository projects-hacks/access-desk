import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { App } from './App';
import { config } from './lib/config';
import { DbConnection } from './module_bindings';
import './styles.css';

// Reads need no token; approvals run as this window's controller seat (?as=a or ?as=b, see lib/config).
const builder = DbConnection.builder().withUri(config.stdbUri).withDatabaseName(config.stdbDatabase);
const connectionBuilder = config.stdbToken ? builder.withToken(config.stdbToken) : builder;

// Demo controls (inject, settle, advance, withdraw, reset) are POSTs to `${apiUrl}/demo/*`.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  </StrictMode>,
);
