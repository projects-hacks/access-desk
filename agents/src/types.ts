import type { DbConnection } from './module_bindings';
import type { AgentTask } from './module_bindings/types';

export const AGENT_NAMES = ['learning', 'scoring', 'exploit', 'access'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** One question to a model; the answer must parse as JSON matching `schema`. See llm/. */
export type Ask = <T>(req: { system: string; prompt: string; schema: Record<string, unknown>; validate?: (v: unknown) => T }) => Promise<T>;

/** Everything an agent gets for one task. */
export interface TaskContext {
  task: AgentTask;
  /** Live cache of the whole database: conn.db.client.iter(), conn.db.invoice.clientId.filter(id), ... */
  conn: DbConnection;
  /** The shared sim date. */
  today: string;
  /** A model call (Droid first, Claude as backup). Throws DecisionUnavailable when neither answers. */
  ask: Ask;
  /** Shows a conclusion on the agents panel (record_agent_step). Say what you decided, not what you looked at. */
  say(text: string, reason?: string): Promise<void>;
  /**
   * Calls a reducer. If the database refuses it, records the refusal on the panel (record_guardrail)
   * and returns the refusal message; returns undefined when it went through.
   */
  attempt(what: string, call: () => Promise<void>, instead?: string): Promise<string | undefined>;
}

/** An agent handles one task: one client, woken for task.reason. Returns what it did, in words. */
export interface Agent {
  name: AgentName;
  /** How many of its tasks may run at once (each on a different client). */
  concurrency: number;
  handle(ctx: TaskContext): Promise<string>;
}
