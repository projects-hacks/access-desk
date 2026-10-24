/** Connects to the shared database and prints row counts. Usage: pnpm stdb:check */
import { tables } from '../module_bindings';
import { env } from '../lib/env';
import { connectStdb } from '../lib/stdb';

const { conn } = await connectStdb();
conn
  .subscriptionBuilder()
  .onApplied(() => {
    console.log(`Connected to ${env.STDB_DATABASE} at ${env.STDB_URI}`);
    for (const [name, table] of Object.entries(conn.db)) {
      if (table && typeof table === 'object' && 'count' in table) console.log(`  ${name}: ${(table as { count(): bigint }).count()} rows`);
    }
    conn.disconnect();
  })
  .subscribe([tables.actor, tables.client, tables.invoice, tables.bankTransaction, tables.workItem, tables.auditEvent]);
