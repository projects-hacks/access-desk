import type { DbConnection } from '../module_bindings';
import type { TaskContext } from '../types';

/** What an action tool writes through: the task's reducers and its guardrail-recording `attempt`. */
export type Actor = Pick<TaskContext, 'attempt'> & { conn: Pick<DbConnection, 'reducers'> };

export interface Outcome {
  tool: string;
  args: Record<string, unknown>;
  /** What the tool answered the model. */
  text: string;
  refused: boolean;
}

/** Too many refusals in one task: the agent should stop pushing and hold off. */
export const MAX_REFUSALS = 3;

/**
 * The one-action rule for a task. After one money or access action goes through (or is recorded,
 * in shadow mode) every further action tool answers "already acted". A refusal does not use the
 * action up, so the agent can adapt, but only MAX_REFUSALS times. In record mode nothing is
 * written: the action is only noted.
 */
export class Gate {
  acted = false;
  refusals = 0;
  readonly outcomes: Outcome[] = [];

  /** `many`: each action is its own (Rowan flags one finding at a time); only refusals are capped. */
  constructor(readonly record = false, readonly many = false) {}

  /** `go` makes the reducer call through ctx.attempt and returns the refusal, if any. */
  async act(tool: string, args: Record<string, unknown>, done: string, go: () => Promise<string | undefined>): Promise<string> {
    const note = (text: string, refused = false) => {
      this.outcomes.push({ tool, args, text, refused });
      return text;
    };
    if (this.acted && !this.many) return 'already acted this task. Finish with one plain sentence.';
    if (this.refusals >= MAX_REFUSALS) return 'refused too many times this task. Hold off and finish with one plain sentence.';
    if (this.record) {
      this.acted = true;
      return note('recorded (shadow)');
    }
    const refusal = await go();
    if (refusal) {
      this.refusals++;
      return note(`refused: ${refusal}`, true);
    }
    this.acted = true;
    return note(done);
  }

  /** A refusal that never reached the database (the tool's own check); it counts like one. */
  refuse(tool: string, args: Record<string, unknown>, why: string): string {
    if (this.acted && !this.many) return 'already acted this task. Finish with one plain sentence.';
    this.refusals++;
    this.outcomes.push({ tool, args, text: `refused: ${why}`, refused: true });
    return `refused: ${why}`;
  }
}
