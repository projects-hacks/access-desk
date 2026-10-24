import { table, t } from 'spacetimedb/server';

/** One reconciliation of bank vs ledger vs subledgers. */
export const tieOutRun = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    simDate: t.string(),
    at: t.timestamp(),
    trigger: t.string(),
    /** tied | explained | break */
    status: t.string(),
    /** Unexplained difference across all areas (absolute sum). */
    unexplainedCents: t.i64(),
    summaryJson: t.string(),
  },
);

/** A difference between two sides of the books, with its reason. */
export const tieOutBreak = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    runId: t.u64().index('btree'),
    /** cash:collections | cash:disbursements | cash:wallet | receivables | unapplied */
    area: t.string(),
    /** in_transit | awaiting_gateway | unexplained */
    kind: t.string(),
    amountCents: t.i64(),
    ref: t.string(),
    detail: t.string(),
  },
);
