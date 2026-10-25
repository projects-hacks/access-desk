import { SenderError, t } from 'spacetimedb/server';
import { AGENTS, MAX_TASK_ATTEMPTS, step, wake, type AgentName } from '../agents';
import { requireRole, type Ctx } from '../context';
import { spacetimedb } from '../schema';

/**
 * The agents' side of the task queue. Only queued tasks can be claimed, so two workers never
 * run one task; only the claimer can finish it. Steps an agent records join its task's episode.
 */

const WORKERS = ['AGENT', 'ADMIN'] as const;

function mine(ctx: Ctx, id: bigint) {
  requireRole(ctx, WORKERS);
  const task = ctx.db.agentTask.id.find(id);
  if (!task) throw new SenderError(`task ${id} not found`);
  if (task.status !== 'running' || !task.claimedBy?.isEqual(ctx.sender)) throw new SenderError(`task ${id} is ${task.status}, not running for you`);
  return task;
}

export const claimAgentTask = spacetimedb.reducer({ id: t.u64() }, (ctx, { id }) => {
  requireRole(ctx, WORKERS);
  const task = ctx.db.agentTask.id.find(id);
  if (!task) throw new SenderError(`task ${id} not found`);
  if (task.status !== 'queued') throw new SenderError(`task ${id} is ${task.status}`);
  ctx.db.agentTask.id.update({ ...task, status: 'running', claimedBy: ctx.sender, attempts: task.attempts + 1, updatedAt: ctx.timestamp });
});

/** Done. `summary` is what the agent did (or why it did nothing), in words. */
export const completeAgentTask = spacetimedb.reducer({ id: t.u64(), summary: t.string() }, (ctx, { id, summary }) => {
  const task = mine(ctx, id);
  ctx.db.agentTask.id.update({ ...task, status: 'done', summary, updatedAt: ctx.timestamp });
});

/** The agent hit an error: back to the queue, or failed after MAX_TASK_ATTEMPTS. */
export const failAgentTask = spacetimedb.reducer({ id: t.u64(), error: t.string() }, (ctx, { id, error }) => {
  const task = mine(ctx, id);
  const failed = task.attempts >= MAX_TASK_ATTEMPTS;
  ctx.db.agentTask.id.update({ ...task, status: failed ? 'failed' : 'queued', claimedBy: undefined, summary: error.slice(0, 500), updatedAt: ctx.timestamp });
});

/** Still working (a long Droid call): keeps the watchdog from requeueing the task. */
export const heartbeatAgentTask = spacetimedb.reducer({ id: t.u64() }, (ctx, { id }) => {
  const task = mine(ctx, id);
  ctx.db.agentTask.id.update({ ...task, updatedAt: ctx.timestamp });
});

/**
 * What the agent concluded, before or instead of acting ("Kestrel is current; releasing the hold").
 * Starts the episode if the task has none yet.
 */
export const recordAgentStep = spacetimedb.reducer(
  { taskId: t.u64(), text: t.string(), reason: t.string() },
  (ctx, { taskId, text, reason }) => {
    const task = mine(ctx, taskId);
    if (!text.trim()) throw new SenderError('empty step');
    const agent = task.agent as AgentName;
    step(ctx, { clientId: task.clientId, actor: agent, agent, text: text.trim(), reason: reason.trim(), opens: true });
  },
);

/**
 * A reducer refused the agent's proposal (its error message is `refusal`). Recorded so the panel
 * shows the guardrail holding, and what the agent did instead, if anything.
 */
export const recordGuardrail = spacetimedb.reducer(
  { taskId: t.u64(), attempted: t.string(), refusal: t.string(), instead: t.string() },
  (ctx, { taskId, attempted, refusal, instead }) => {
    const task = mine(ctx, taskId);
    step(ctx, {
      clientId: task.clientId, actor: 'guardrail', agent: task.agent as AgentName, opens: true,
      text: `Refused: ${attempted.trim()}`, checks: [{ ok: false, label: refusal.trim() }], instead: instead.trim(),
    });
  },
);

/** Queue one agent for every client (first start on an existing world). */
export const queueSweep = spacetimedb.reducer({ agent: t.string(), reason: t.string() }, (ctx, { agent, reason }) => {
  requireRole(ctx, WORKERS);
  if (!(AGENTS as readonly string[]).includes(agent)) throw new SenderError(`unknown agent ${agent}`);
  for (const c of [...ctx.db.client.iter()]) wake(ctx, agent as AgentName, c.id, reason);
});
