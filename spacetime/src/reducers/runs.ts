import { Timestamp } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import { audit, requireRole } from '../context';
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

/**
 * The agent looked at a client who owes money and chose not to act, and why
 * (cure period running, wire in transit, promise to pay, ...). Audited so
 * "why wasn't this client restricted on March 3?" has an answer.
 */
export const recordWait = spacetimedb.reducer(
  { clientId: t.string(), code: t.string(), reason: t.string() },
  (ctx, { clientId, code, reason }) => {
    requireRole(ctx, ['AGENT', 'ADMIN']);
    if (!ctx.db.client.id.find(clientId)) throw new SenderError(`unknown client ${clientId}`);
    audit(ctx, { action: 'AGENT_WAITED', subjectType: 'client', subjectId: clientId, clientId, toState: code, detail: reason });
  },
);
