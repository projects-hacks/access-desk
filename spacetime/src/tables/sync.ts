import { table, t } from 'spacetimedb/server';

export const syncSource = table(
  { public: true },
  {
    source: t.string().primaryKey(),
    label: t.string(),
    status: t.string(),
    recordCount: t.u32(),
    cursor: t.string(),
    lastSyncAt: t.timestamp().optional(),
    error: t.string().optional(),
  },
);

/** Source rows as received. Every golden row points back here. */
export const rawRecord = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    source: t.string().index('btree'),
    hash: t.string(),
    payloadJson: t.string(),
    firstSeenAt: t.timestamp(),
    lastSeenAt: t.timestamp(),
    goldenTable: t.string(),
    goldenId: t.string(),
  },
);
