import { table, t } from 'spacetimedb/server';

/** A client's buy or sell on the platform. Refused orders are kept, with the reason. */
export const tradeOrder = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    clientId: t.string().index('btree'),
    /** buy | sell */
    side: t.string(),
    asset: t.string(),
    /** US dollars spent (buy) or received (sell). */
    amountCents: t.i64(),
    quantity: t.f64(),
    /** The live price the order was checked at. */
    priceCents: t.i64(),
    /** refused | queued | filled | failed */
    status: t.string(),
    reason: t.string(),
    at: t.timestamp(),
  },
);
