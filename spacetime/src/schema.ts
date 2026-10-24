import { schema } from 'spacetimedb/server';
import { actor, auditEvent, bankTransaction, client, invoice, policy, syncCursor, workItem } from './tables';

export const spacetimedb = schema({
  actor,
  client,
  invoice,
  bankTransaction,
  syncCursor,
  workItem,
  policy,
  auditEvent,
});
