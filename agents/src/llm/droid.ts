import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutonomyLevel, createSession, DroidMessageType, OutputFormatType, ReasoningEffort, type DroidResult, type DroidSession } from '@factory/droid-sdk/node';
import { env } from '../env';
import { DecisionUnavailable } from './errors';
import type { Provider } from './index';

const TIMEOUT_MS = 120_000;
/** A session under load sometimes times out or is cut short; a fresh one usually answers. */
const ATTEMPTS = 2;

/**
 * Factory's Droid as the model behind a decision: one short-lived session per call, locked
 * down (no tools, no permissions granted, an empty temp directory). It only supplies text;
 * the caller validates whatever comes back.
 */
export const droid: Provider = {
  name: 'factory',
  async answer(prompt, schema) {
    let last: unknown;
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        return await session(prompt, schema);
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof DecisionUnavailable ? last : new DecisionUnavailable(`droid failed: ${String(last)}`);
  },
};

async function session(prompt: string, schema: Record<string, unknown>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'desk-droid-'));
  const abortSignal = AbortSignal.timeout(TIMEOUT_MS);
  let droidSession: DroidSession | undefined;
  try {
    droidSession = await createSession({
      cwd,
      apiKey: env.FACTORY_API_KEY,
      machineId: 'access-desk',
      modelId: env.LLM_MODEL,
      autonomyLevel: AutonomyLevel.Off,
      reasoningEffort: ReasoningEffort.Low,
      disableBuiltinSkills: true,
      autoRejectPermissionRequests: true,
      abortSignal,
    });
    // The SDK has no "no tools" switch: disable every tool the session offers.
    await droidSession.updateSettings({ disabledToolIds: (await droidSession.listTools()).map((t) => t.id) });
    let result: DroidResult | undefined;
    for await (const m of droidSession.stream(prompt, { outputFormat: { type: OutputFormatType.JsonSchema, schema }, abortSignal })) {
      if (m.type === DroidMessageType.Result) result = m;
    }
    if (!result) throw new DecisionUnavailable('droid ended without a result');
    if (!result.success) {
      throw new DecisionUnavailable(`droid ${result.subtype}: ${(result.structuredOutputError ?? result.error)?.message ?? 'no detail'}`.slice(0, 300));
    }
    const text = result.structuredOutput !== undefined ? JSON.stringify(result.structuredOutput) : result.text.trim();
    if (!text) throw new DecisionUnavailable('droid returned no answer');
    return text;
  } catch (e) {
    if (e instanceof DecisionUnavailable) throw e;
    const timedOut = abortSignal.aborted || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'));
    throw new DecisionUnavailable(timedOut ? `droid timed out after ${TIMEOUT_MS / 1000}s` : `droid failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await droidSession?.close().catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
}
