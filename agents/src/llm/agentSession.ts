import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutonomyLevel, createSession, DroidMessageType, ReasoningEffort, ToolConfirmationOutcome, type DroidResult, type DroidSession } from '@factory/droid-sdk/node';
import { env } from '../env';
import { SERVER_NAME, toolServer } from '../tools/server';
import type { Toolset } from '../tools/toolset';
import { droidInstalled } from './index';
import { inTurn } from './turn';

const TIMEOUT_MS = 120_000;
/** Droid reaches MCP tools as `<server>___<tool>`, through its ToolSearch and Script tools. */
const OURS = `${SERVER_NAME}___`;
const GLUE = new Set(['ToolSearch', 'Script', 'WaitForScript']);

export interface AgentRun {
  ok: boolean;
  /** The agent's last words: one plain sentence about what it did and why. */
  text: string;
  ms: number;
  error?: string;
}

export const agentSessionsAvailable = () => !!env.FACTORY_API_KEY && droidInstalled();

/** Approve a request only when every tool it would run is one of ours. */
export function approves(request: unknown): boolean {
  const uses: any[] = (request as any)?.toolUses ?? [];
  if (!uses.length) return false;
  return uses.every((u) => {
    const d = u?.details;
    if (d?.type === 'mcp_tool') return d.serverName === SERVER_NAME;
    if (d?.type === 'script') return Array.isArray(d.calls) && d.calls.length > 0 && d.calls.every((c: any) => String(c?.toolName ?? '').startsWith(OURS));
    return false;
  });
}

/**
 * One Droid session that works on one task through its MCP tools: every built-in tool is turned
 * off, the session sees only `toolset` (bound to one client), and a permission is granted only
 * for those tools. Holds one of the global LLM slots for the whole session. Never throws: a
 * timeout or failure comes back as ok = false so the caller can take the rules path.
 */
export async function runAgent(toolset: Toolset, role: string, prompt: string, timeoutMs = TIMEOUT_MS): Promise<AgentRun> {
  return inTurn(async () => {
    const started = Date.now();
    const done = (r: Omit<AgentRun, 'ms'>): AgentRun => ({ ...r, ms: Date.now() - started });
    const abortSignal = AbortSignal.timeout(timeoutMs);
    const binding = await toolServer().bind(toolset);
    const cwd = await mkdtemp(join(tmpdir(), 'desk-agent-'));
    let session: DroidSession | undefined;
    try {
      session = await createSession({
        cwd, apiKey: env.FACTORY_API_KEY, machineId: 'access-desk', modelId: env.LLM_MODEL, autonomyLevel: AutonomyLevel.Off, reasoningEffort: ReasoningEffort.Low,
        disableBuiltinSkills: true, mcpServers: [binding.config], systemPrompt: { type: 'preset', preset: 'droid', append: role }, abortSignal,
        permissionHandler: (request) => (approves(request) ? ToolConfirmationOutcome.ProceedOnce : ToolConfirmationOutcome.Cancel),
      });
      const tools = await session.listTools();
      await session.updateSettings({ disabledToolIds: tools.map((t) => t.id).filter((id) => !id.startsWith(OURS) && !GLUE.has(id)) });
      let result: DroidResult | undefined;
      for await (const m of session.stream(prompt, { abortSignal })) if (m.type === DroidMessageType.Result) result = m;
      if (!result) return done({ ok: false, text: '', error: 'droid ended without a result' });
      if (!result.success) return done({ ok: false, text: '', error: `droid ${result.subtype}: ${result.error?.message ?? 'no detail'}`.slice(0, 300) });
      return done({ ok: true, text: result.text.trim() });
    } catch (e) {
      const timedOut = abortSignal.aborted || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'));
      return done({ ok: false, text: '', error: timedOut ? `droid timed out after ${timeoutMs / 1000}s` : `droid failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
    } finally {
      binding.release();
      await session?.close().catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
