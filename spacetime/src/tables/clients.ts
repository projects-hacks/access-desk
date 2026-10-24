import { table, t } from 'spacetimedb/server';

export const client = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    name: t.string(),
    legalName: t.string(),
    segment: t.string(),
    tier: t.u8(),
    strategic: t.bool(),
    relationshipManager: t.string(),
    renewalOn: t.string().optional(),
    status: t.string(),
  },
);

/** How a payer shows up in cash: bank account, wallet, name alias or affiliate. */
export const payerIdentity = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    clientId: t.string().index('btree'),
    kind: t.string(),
    value: t.string().index('btree'),
    label: t.string(),
    relation: t.string(),
    verified: t.bool(),
  },
);

export const contract = table(
  { public: true },
  {
    clientId: t.string().primaryKey(),
    msaRef: t.string(),
    termsDays: t.u16(),
    graceDays: t.u16(),
    cureDays: t.u16(),
    crossDefault: t.bool(),
  },
);

export const contractClause = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    clientId: t.string().index('btree'),
    clause: t.string(),
    kind: t.string(),
    allowed: t.bool(),
    text: t.string(),
  },
);

/** What this platform's admin system can do. Allowed actions = capability ∩ contract clauses. */
export const capability = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    product: t.string(),
    lever: t.string(),
    step: t.string(),
    gentleness: t.u8(),
    reversible: t.bool(),
    twoApprovers: t.bool(),
    adapterAction: t.string(),
  },
);

export const accessLever = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    clientId: t.string().index('btree'),
    lever: t.string(),
    state: t.string(),
    detail: t.string(),
    workItemId: t.u64().optional(),
  },
);
