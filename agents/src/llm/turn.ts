/**
 * Model calls in flight across all four agents. Each Droid call (a one-question ask or a whole
 * tool-using agent session) is its own CLI process, so this (not the agents' concurrency) is what
 * bounds the container's memory; the rest wait their turn.
 */
const MAX_IN_FLIGHT = Number(process.env.LLM_CONCURRENCY ?? 2);
let inFlight = 0;
const waiting: (() => void)[] = [];

export async function inTurn<T>(call: () => Promise<T>): Promise<T> {
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
