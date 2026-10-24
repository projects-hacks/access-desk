import { table, t } from 'spacetimedb/server';

export const creditProfile = table(
  { public: true },
  {
    clientId: t.string().primaryKey(),
    valueScore: t.u8(),
    reliabilityScore: t.u8(),
    coverageRatio: t.f64(),
    coverageDetail: t.string(),
    expectedSettleOn: t.string().optional(),
    updatedAt: t.timestamp(),
  },
);

/** Versioned rules. key = `pol-014@2`. */
export const policy = table(
  { public: true },
  {
    key: t.string().primaryKey(),
    policyId: t.string().index('btree'),
    version: t.u32(),
    status: t.string(),
    title: t.string(),
    ruleJson: t.string(),
    learnedFrom: t.string(),
    approvedBy: t.string().optional(),
  },
);

export const precedent = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    workItemId: t.u64().index('btree'),
    clientId: t.string().index('btree'),
    situation: t.string(),
    decision: t.string(),
    overrideReason: t.string(),
    outcome: t.string(),
  },
);

export const exploitFlag = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    clientId: t.string().index('btree'),
    pattern: t.string(),
    score: t.f32(),
    status: t.string(),
    months: t.u8(),
    evidenceJson: t.string(),
    proposedFix: t.string(),
  },
);
