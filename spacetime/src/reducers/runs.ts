import { Timestamp } from 'spacetimedb';
import { t } from 'spacetimedb/server';
import { requireRole } from '../context';
import { spacetimedb } from '../schema';

/**
 * One pass of an agent, for the live view of who is working. Not an audit row:
 * what the agent did is already audited by the reducers it called.
 */
export const recordAgentRun = spacetimedb.reducer(
  { agent: t.string(), trigger: t.string(), proposed: t.u32(), status: t.string(), error: t.string().optional(), durationMs: t.u32() },
  (ctx, { agent, trigger, proposed, status, error, durationMs }) => {
    requireRole(ctx, ['AGENT', 'ADMIN']);
    const finishedAt = ctx.timestamp;
    const startedAt = new Timestamp(finishedAt.microsSinceUnixEpoch - BigInt(durationMs) * 1000n);
    ctx.db.agentRun.insert({ id: 0n, agent, trigger, startedAt, finishedAt, proposed, status, error });
  },
);
