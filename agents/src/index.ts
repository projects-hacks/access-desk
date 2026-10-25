import { connect } from './db';
import { Dispatcher, dryContext } from './dispatcher';
import { env } from './env';
import { makeAsk } from './llm';
import { access } from './agents/access';
import { exploit } from './agents/exploit';
import { learning } from './agents/learning';
import { scoring } from './agents/scoring';
import { AGENT_NAMES, type AgentName } from './types';

const AGENTS = [learning, scoring, exploit, access];

/**
 * pnpm agents                          run the four agents on queued tasks (the hosted process only)
 * pnpm agents:try <agent> <client>     one agent on one client, printing what it would do; no writes
 */
async function main() {
  const [command, agentName, clientId, ...reason] = process.argv.slice(2);
  if (command === 'try') {
    const agent = AGENTS.find((a) => a.name === agentName);
    if (!agent || !clientId) throw new Error(`usage: try <${AGENT_NAMES.join('|')}> <clientId> [reason]`);
    const conn = await connect();
    const ctx = dryContext(conn, makeAsk(), agentName as AgentName, clientId, reason.join(' ') || 'tried by hand');
    console.log(`${agent.name} on ${clientId} (${ctx.today}), dry run:`);
    console.log(`  → ${await agent.handle(ctx)}`);
    process.exit(0);
  }
  if (!env.AGENTS_HOST) {
    console.error('The agents act on the shared database, so only the hosted process runs them (AGENTS_HOST=true).\nUse `pnpm agents:try <agent> <client>` to see what one would do.');
    process.exit(1);
  }
  const conn = await connect();
  new Dispatcher(conn, AGENTS, makeAsk()).start();
  console.log(`[agents] ${AGENTS.map((a) => `${a.name}×${a.concurrency}`).join(', ')} waiting for tasks`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
