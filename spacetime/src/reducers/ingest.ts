import { t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';

/** Idempotent upsert by stable id, so re-reading a late bank post is safe. */
export const recordBankTransaction = spacetimedb.reducer(
  {
    source: t.string(),
    sourceRef: t.string(),
    payerName: t.string(),
    amountCents: t.i64(),
    postedAt: t.timestamp(),
    rawJson: t.string(),
  },
  (ctx, args) => {
    const row = { id: `${args.source}:${args.sourceRef}`, ...args };
    if (ctx.db.bankTransaction.id.find(row.id)) ctx.db.bankTransaction.id.update(row);
    else ctx.db.bankTransaction.insert(row);
  },
);

export const advanceSyncCursor = spacetimedb.reducer(
  { source: t.string(), cursor: t.string() },
  (ctx, { source, cursor }) => {
    const row = { source, cursor, updatedAt: ctx.timestamp };
    if (ctx.db.syncCursor.source.find(source)) ctx.db.syncCursor.source.update(row);
    else ctx.db.syncCursor.insert(row);
  },
);
