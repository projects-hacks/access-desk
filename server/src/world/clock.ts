/**
 * Who owns the sim clock. The world keeps it at its pace, but never fights a person:
 *  - already at the pace: nothing to do;
 *  - running at another pace, or with a stop date: someone chose that on purpose, leave it;
 *  - paused: a person may be pausing to talk, so it is only resumed after `graceMs`
 *    (also what puts it back after a run-until stop or a database reset).
 */
export type ClockDecision = 'ok' | 'resume' | 'foreign' | 'paused';

export function clockDecision(
  clock: { secondsPerDay: number; runUntil?: string; updatedAtMs: number },
  want: { secondsPerDay: number; graceMs: number },
  nowMs: number,
): ClockDecision {
  if (want.secondsPerDay === 0) return 'ok';
  if (clock.secondsPerDay === want.secondsPerDay && !clock.runUntil) return 'ok';
  if (clock.secondsPerDay > 0) return 'foreign';
  return nowMs - clock.updatedAtMs >= want.graceMs ? 'resume' : 'paused';
}
