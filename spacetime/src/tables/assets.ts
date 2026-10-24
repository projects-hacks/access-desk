import { table, t } from 'spacetimedb/server';

export const custodyHolding = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    clientId: t.string().index('btree'),
    asset: t.string(),
    quantity: t.f64(),
    valueCents: t.i64(),
  },
);

export const assetPrice = table(
  { public: true },
  {
    asset: t.string().primaryKey(),
    priceCents: t.i64(),
    asOf: t.string(),
  },
);

export const hold = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    clientId: t.string().index('btree'),
    amountCents: t.i64(),
    reason: t.string(),
    clause: t.string(),
    workItemId: t.u64().optional(),
    status: t.string(),
    createdAt: t.timestamp(),
    releasedAt: t.timestamp().optional(),
  },
);

/** Money the platform owes the client: staking rewards, rebates, unsettled proceeds. */
export const owedToClient = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    clientId: t.string().index('btree'),
    kind: t.string(),
    amountCents: t.i64(),
    asOf: t.string(),
  },
);

export const position = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    clientId: t.string().index('btree'),
    instrument: t.string(),
    side: t.string(),
    notionalCents: t.i64(),
    hedgeGroup: t.string().optional(),
    status: t.string(),
  },
);

export const loan = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    clientId: t.string().index('btree'),
    lineCents: t.i64(),
    outstandingCents: t.i64(),
    status: t.string(),
    borrowingAllowed: t.bool(),
  },
);
