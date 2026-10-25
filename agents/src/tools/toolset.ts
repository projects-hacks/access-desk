import { z } from 'zod';

/** One tool a Droid session may call. Bound to one task, so no tool takes a client id. */
export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
  /** Read tools change nothing; action tools go through the task's one-action gate. */
  readOnly: boolean;
  run(args: Record<string, any>): Promise<string>;
}

export interface ToolCallLog {
  name: string;
  args: unknown;
  result: string;
  ms: number;
}

/** The tools of one task and a log of every call made on them. */
export class Toolset {
  readonly calls: ToolCallLog[] = [];

  constructor(readonly defs: ToolDef[]) {}

  /** Runs a tool the way the server does: arguments checked, failures returned as text. */
  async call(name: string, args: unknown = {}): Promise<string> {
    const started = Date.now();
    let result: string;
    const def = this.defs.find((d) => d.name === name);
    if (!def) result = `error: no tool named ${name}`;
    else {
      const parsed = z.object(def.input).safeParse(args ?? {});
      if (!parsed.success) result = `error: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join(', ')}`;
      else {
        try {
          result = await def.run(parsed.data);
        } catch (e) {
          result = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
    this.calls.push({ name, args, result, ms: Date.now() - started });
    return result;
  }
}
