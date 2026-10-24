import { table, t } from 'spacetimedb/server';

// Money is integer cents (i64) everywhere. Never floats.

/** Who is calling reducers, and in which role. */
export const actor = table(
  { public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    role: t.string(),
  },
);

// ── Golden records (synced from systems of record) ──────────────────────────

export const client = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    name: t.string(),
    tier: t.string(),
    relationshipManager: t.string(),
  },
);

export const invoice = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    clientId: t.string().index('btree'),
    product: t.string(),
    amountCents: t.i64(),
    paidCents: t.i64(),
    dueAt: t.timestamp(),
    status: t.string(),
  },
);

export const bankTransaction = table(
  { public: true },
  {
    /** Stable id: `${source}:${sourceRef}`. Re-reads of a late post update in place. */
    id: t.string().primaryKey(),
    source: t.string(),
    sourceRef: t.string(),
    payerName: t.string(),
    amountCents: t.i64(),
    postedAt: t.timestamp(),
    rawJson: t.string(),
  },
);

/** Change-only sync position per source. */
export const syncCursor = table(
  { public: true },
  {
    source: t.string().primaryKey(),
    cursor: t.string(),
    updatedAt: t.timestamp(),
  },
);

// ── System of work ──────────────────────────────────────────────────────────

export const workItem = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    kind: t.string(),
    clientId: t.string().index('btree'),
    state: t.string(),
    summary: t.string(),
    proposalJson: t.string(),
    proposedBy: t.identity(),
    policyVersion: t.string(),
    updatedAt: t.timestamp(),
  },
);

/** Versioned rules the agents follow; drafted from precedents, approved by a human. */
export const policy = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    version: t.u32(),
    status: t.string(),
    ruleJson: t.string(),
    learnedFrom: t.string(),
  },
);

/** Append-only. Written in the same reducer (transaction) as the change it records. */
export const auditEvent = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    workItemId: t.u64().index('btree'),
    actor: t.identity(),
    action: t.string(),
    fromState: t.string(),
    toState: t.string(),
    allowed: t.bool(),
    detail: t.string(),
    at: t.timestamp(),
  },
);
