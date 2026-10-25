import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { env } from '../env';
import type { Ask } from '../types';
import { claude } from './claude';
import { droid } from './droid';
import { AnswerRejected, DecisionUnavailable } from './errors';

export { AnswerRejected, DecisionUnavailable };

/** Who answered; `validate` receives it as a second argument. */
export interface Answered {
  provider: string;
  model: string;
}

/** One model behind the Ask: a prompt in, the raw answer text out (it must be JSON matching `schema`). */
export interface Provider {
  name: string;
  answer(prompt: string, schema: Record<string, unknown>): Promise<string>;
}

const RETRY_NOTE = 'Your previous answer was rejected. Answer the original request again, fixing this:';

/** The `droid` CLI is found on PATH (the SDK starts it as a subprocess). */
function droidInstalled(): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try {
      accessSync(join(dir, 'droid'), constants.X_OK);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/** Droid first, then Claude; whichever is not set up is skipped. */
export function configuredProviders(): Provider[] {
  return [env.FACTORY_API_KEY && droidInstalled() ? droid : undefined, env.ANTHROPIC_API_KEY ? claude : undefined].filter((p): p is Provider => !!p);
}

/** A reply is JSON, possibly inside a code fence. */
function clean(text: string): string {
  const t = text.trim();
  return /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t)?.[1] ?? t;
}

/**
 * Model calls in flight across all four agents. Each Droid call is its own CLI process, so this
 * (not the agents' concurrency) is what bounds the container's memory; the rest wait their turn.
 */
const MAX_IN_FLIGHT = Number(process.env.LLM_CONCURRENCY ?? 2);
let inFlight = 0;
const waiting: (() => void)[] = [];

async function inTurn<T>(call: () => Promise<T>): Promise<T> {
  // A finished call hands its slot straight to the next waiter, so the count never overshoots.
  if (inFlight < MAX_IN_FLIGHT) inFlight++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await call();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

async function answer(providers: Provider[], prompt: string, schema: Record<string, unknown>): Promise<{ text: string; by: Answered }> {
  const failures: string[] = [];
  for (const p of providers) {
    try {
      return { text: await inTurn(() => p.answer(prompt, schema)), by: { provider: p.name, model: env.LLM_MODEL } };
    } catch (e) {
      failures.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new DecisionUnavailable(providers.length ? failures.join('; ') : 'no model is set up (no droid on PATH or FACTORY_API_KEY, no ANTHROPIC_API_KEY)');
}

/**
 * An Ask over these providers, tried in order (a failure hands the call to the next). The
 * answer is parsed and passed to `validate` (with who answered as a second argument); if
 * either rejects it, the model is asked once more with the rejection note, then the call gives
 * up with AnswerRejected. DecisionUnavailable when no provider answers at all.
 */
export function askWith(providers: Provider[]): Ask {
  return async ({ system, prompt, schema, validate }) => {
    const base = system ? `${system}\n\n${prompt}` : prompt;
    let note = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text, by } = await answer(providers, note ? `${base}\n\n${RETRY_NOTE}\n${note}` : base, schema);
      try {
        const value: unknown = JSON.parse(clean(text));
        return (validate ? (validate as (v: unknown, by: Answered) => unknown)(value, by) : value) as never;
      } catch (e) {
        note = e instanceof SyntaxError ? 'The answer was not valid JSON.' : e instanceof Error ? e.message : String(e);
      }
    }
    throw new AnswerRejected(`the answer was rejected twice: ${note}`.slice(0, 500));
  };
}

/** Droid first, Claude as backup (ported from agents-py/src/desk_agents/llm). */
export function makeAsk(): Ask {
  return askWith(configuredProviders());
}
