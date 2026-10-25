import { table, t } from 'spacetimedb/server';

/**
 * Work for one agent on one client. Queued by the reducer that made the change, in the same
 * transaction; pushed to the agents over their subscription; claimed, then done or failed.
 * At most one queued task per agent and client: later changes fold into it.
 */
export const agentTask = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    /** learning | scoring | exploit | access */
    agent: t.string().index('btree'),
    clientId: t.string().index('btree'),
    /** What woke it, in words ("Wire of $148,200.00 from Zephyr Capital"). */
    reason: t.string(),
    /** The episode it belongs to; 0 for background work (startup, the daily sweep). */
    episodeId: t.u64().index('btree'),
    /** queued → running → done | failed */
    status: t.string().index('btree'),
    claimedBy: t.identity().optional(),
    attempts: t.u16(),
    /** What the agent did, in words, or the last error. */
    summary: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

/** One thing that happened to a client and everything the desk did about it. */
export const episode = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    clientId: t.string().index('btree'),
    trigger: t.string(),
    /** The latest step that changed something, in words. */
    outcome: t.string(),
    /** auto | stopped (a guardrail refused something) | waiting (a person must decide) */
    kind: t.string(),
    startedAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

export const Check = t.object('Check', { ok: t.bool(), label: t.string() });

/** One step of an episode, written in the same transaction as the change it describes. */
export const episodeStep = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    episodeId: t.u64().index('btree'),
    clientId: t.string(),
    /** bank | payment | platform | scheduler | learning | scoring | exploit | access | guardrail | gateway | person */
    actor: t.string(),
    text: t.string(),
    /** The agent's reasoning, when an agent acted. */
    reason: t.string(),
    /** Guardrails the step passed (ok) or was refused by. */
    checks: t.array(Check),
    /** What happened instead of a refused step. */
    instead: t.string(),
    /** The work item the step is about; 0 for none. Approvals later find their episode by it. */
    workItemId: t.u64().index('btree'),
    at: t.timestamp(),
  },
);
