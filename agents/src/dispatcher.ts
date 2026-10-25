import type { DbConnection } from './module_bindings';
import type { AgentTask } from './module_bindings/types';
import type { Agent, AgentName, Ask, TaskContext } from './types';

const HEARTBEAT_MS = 60_000;
/** Safety net for a push missed across a reconnect. */
const RESCAN_MS = 10_000;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Runs the agents on tasks the database queues. No polling: new and requeued tasks are pushed
 * by the subscription. Each agent runs up to its `concurrency` tasks at once, never two for the
 * same client; the four agents run independently of each other. A task is claimed first, so a
 * second dispatcher (or a restart) can never run it twice.
 */
export class Dispatcher {
  private readonly agents = new Map<string, Agent>();
  private readonly running = new Map<AgentName, number>();
  private readonly busy = new Set<string>();

  constructor(
    private readonly conn: DbConnection,
    agents: Agent[],
    private readonly ask: Ask,
    private readonly log: (msg: string) => void = console.log,
  ) {
    for (const a of agents) this.agents.set(a.name, a);
  }

  start(): () => void {
    this.conn.db.agentTask.onInsert((_ctx, row) => this.offer(row));
    this.conn.db.agentTask.onUpdate((_ctx, _old, row) => this.offer(row));
    // First start on a world with no tasks at all: every client gets a credit profile.
    if (![...this.conn.db.agentTask.iter()].length) {
      this.conn.reducers.queueSweep({ agent: 'learning', reason: 'Agents started: first credit profile' }).catch((e) => this.log(`[agents] sweep failed: ${errorText(e)}`));
    }
    this.scan();
    const timer = setInterval(() => this.scan(), RESCAN_MS);
    return () => clearInterval(timer);
  }

  private scan() {
    const queued = [...this.conn.db.agentTask.status.filter('queued')].sort((a, b) => Number(a.id - b.id));
    for (const t of queued) this.offer(t);
  }

  private offer(t: AgentTask) {
    if (t.status !== 'queued') return;
    const agent = this.agents.get(t.agent);
    if (!agent) return;
    const key = `${t.agent}:${t.clientId}`;
    if (this.busy.has(key) || (this.running.get(agent.name) ?? 0) >= agent.concurrency) return;
    this.busy.add(key);
    this.running.set(agent.name, (this.running.get(agent.name) ?? 0) + 1);
    void this.run(agent, t).finally(() => {
      this.busy.delete(key);
      this.running.set(agent.name, (this.running.get(agent.name) ?? 1) - 1);
      this.scan();
    });
  }

  private async run(agent: Agent, t: AgentTask) {
    try {
      await this.conn.reducers.claimAgentTask({ id: t.id });
    } catch {
      return; // claimed elsewhere, or no longer queued
    }
    const started = Date.now();
    const heartbeat = setInterval(() => this.conn.reducers.heartbeatAgentTask({ id: t.id }).catch(() => {}), HEARTBEAT_MS);
    try {
      const summary = await agent.handle(this.context(t));
      await this.conn.reducers.completeAgentTask({ id: t.id, summary });
      this.log(`[${agent.name}] ${t.clientId} · ${summary} (${Date.now() - started} ms)`);
    } catch (e) {
      this.log(`[${agent.name}] ${t.clientId} failed: ${errorText(e)}`);
      await this.conn.reducers.failAgentTask({ id: t.id, error: errorText(e) }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
    }
  }

  context(task: AgentTask): TaskContext {
    const conn = this.conn;
    return {
      task, conn, ask: this.ask,
      today: conn.db.clock.id.find(1)?.simDate ?? '',
      say: (text, reason = '') => conn.reducers.recordAgentStep({ taskId: task.id, text, reason }),
      attempt: async (what, call, instead = '') => {
        try {
          await call();
          return undefined;
        } catch (e) {
          const refusal = errorText(e);
          await conn.reducers.recordGuardrail({ taskId: task.id, attempted: what, refusal, instead }).catch(() => {});
          return refusal;
        }
      },
    };
  }
}

/**
 * The same context with no writes: say/attempt print instead of calling reducers. For trying an
 * agent on one client against the shared database (pnpm agents:try).
 */
export function dryContext(conn: DbConnection, ask: Ask, agent: AgentName, clientId: string, reason: string): TaskContext {
  const now = { __timestamp_micros_since_unix_epoch__: BigInt(Date.now()) * 1000n } as unknown as AgentTask['createdAt'];
  const task: AgentTask = {
    id: 0n, agent, clientId, reason, episodeId: 0n, status: 'running', claimedBy: undefined, attempts: 1, summary: '', createdAt: now, updatedAt: now,
  };
  return {
    task, conn, ask,
    today: conn.db.clock.id.find(1)?.simDate ?? '',
    say: async (text, why) => console.log(`  say: ${text}${why ? `\n       “${why}”` : ''}`),
    attempt: async (what) => {
      console.log(`  would: ${what}`);
      return undefined;
    },
  };
}
