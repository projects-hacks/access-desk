import type { Agent } from './agent';

const INTERVAL_MS = 15_000;

/** TODO: trigger from SpacetimeDB subscriptions instead of polling. */
export function startAgents(agents: Agent[], log: (msg: string) => void) {
  const timer = setInterval(async () => {
    for (const agent of agents) {
      try {
        await agent.run();
      } catch (err) {
        log(`[agent:${agent.name}] ${String(err)}`);
      }
    }
  }, INTERVAL_MS);
  return () => clearInterval(timer);
}
