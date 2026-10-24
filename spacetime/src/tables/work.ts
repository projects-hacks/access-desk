import { table, t } from 'spacetimedb/server';

export const workItem = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    kind: t.string(),
    clientId: t.string().index('btree'),
    subjectId: t.string(),
    state: t.string(),
    title: t.string(),
    amountCents: t.i64(),
    proposalJson: t.string(),
    reasoning: t.string(),
    policyRef: t.string(),
    clausesCited: t.array(t.string()),
    boundariesJson: t.string(),
    confidence: t.f32(),
    autoApplied: t.bool(),
    requiredRole: t.string(),
    proposedBy: t.identity(),
    revision: t.u32(),
    revisedFrom: t.u64().optional(),
    expiresOn: t.string().optional(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

export const decision = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    workItemId: t.u64().index('btree'),
    revision: t.u32(),
    decidedBy: t.identity(),
    role: t.string(),
    decision: t.string(),
    reasonCode: t.string(),
    note: t.string(),
    at: t.timestamp(),
  },
);

export const investigationStep = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    workItemId: t.u64().index('btree'),
    seq: t.u16(),
    tool: t.string(),
    summary: t.string(),
    status: t.string(),
  },
);

export const rmNote = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    clientId: t.string().index('btree'),
    workItemId: t.u64().optional(),
    author: t.string(),
    text: t.string(),
    at: t.timestamp(),
  },
);

export const notice = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    clientId: t.string().index('btree'),
    workItemId: t.u64().optional(),
    channel: t.string(),
    body: t.string(),
    status: t.string(),
    sentAt: t.timestamp().optional(),
  },
);

/** Outbox: approved actions waiting for the gateway to execute against external systems. */
export const gatewayCommand = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    workItemId: t.u64().index('btree'),
    actionJson: t.string(),
    status: t.string(),
    externalRef: t.string().optional(),
    attempts: t.u16(),
    error: t.string().optional(),
  },
);

/** The platform asking before a client withdraws, trades, borrows or calls the API. */
export const accessRequest = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    clientId: t.string().index('btree'),
    action: t.string(),
    amountCents: t.i64(),
    decision: t.string(),
    allowedCents: t.i64(),
    heldCents: t.i64(),
    reason: t.string(),
    at: t.timestamp(),
  },
);

export const deadline = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    kind: t.string(),
    clientId: t.string().index('btree'),
    workItemId: t.u64().optional(),
    dueOn: t.string(),
    status: t.string(),
  },
);

export const agentRun = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    agent: t.string(),
    trigger: t.string(),
    startedAt: t.timestamp(),
    finishedAt: t.timestamp().optional(),
    proposed: t.u32(),
    status: t.string(),
    error: t.string().optional(),
  },
);
