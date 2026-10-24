import { table, t } from 'spacetimedb/server';

/** Append-only. Written in the same reducer (transaction) as the change it records. */
export const auditEvent = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp(),
    simDate: t.string(),
    actor: t.identity(),
    actorRole: t.string(),
    actorName: t.string(),
    action: t.string(),
    subjectType: t.string(),
    subjectId: t.string(),
    clientId: t.string().index('btree'),
    workItemId: t.u64().optional(),
    fromState: t.string(),
    toState: t.string(),
    allowed: t.bool(),
    detail: t.string(),
    policyRef: t.string(),
  },
);
