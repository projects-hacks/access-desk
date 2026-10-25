import { writeFileSync } from 'node:fs';
import { prepare } from './agents/access';
import { connect } from './db';
import { dryContext } from './dispatcher';
import { makeAsk } from './llm';
import { rowanFacts, sageFacts } from './tools/facts';
import { droidChoice, agrees, investigateRowan, investigateSage, needsJudgment, rowanWork, rulesChoice, type Investigation } from './tools/investigate';
import type { AgentName } from './types';

/**
 * pnpm --filter @access-desk/agents shadow <access|exploit|both> [clients...] [--all] [--out file.json]
 *
 * Runs the Droid agents in shadow (their action tools write nothing, the panel is not touched;
 * the context is the dry-run one) and prints the rules' decision next to the agent's, with the
 * tools the session called. By default only tasks the real path would hand to Droid get a
 * session; --all gives every client one.
 */

const CONCURRENCY = 2;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const [which = 'both', ...named] = positional;

interface Row {
  agent: string;
  clientId: string;
  name: string;
  routine: boolean;
  rules: string;
  droid: string;
  agree: boolean;
  calls: string[];
  ms: number;
  text: string;
  error?: string;
  detail?: unknown;
}

async function pool<T>(items: T[], n: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  }));
}

function show(r: Row) {
  console.log(`\n${r.agent} · ${r.clientId} ${r.name}${r.routine ? ' · routine, rules path' : ''}`);
  console.log(`  rules: ${r.rules}`);
  if (r.routine) return;
  console.log(`  droid: ${r.droid}  [${r.error ? 'NO ANSWER' : r.agree ? 'agree' : 'DIFFER'}]  ${r.calls.length} calls, ${Math.round(r.ms / 1000)}s`);
  console.log(`  tools: ${r.calls.join(', ') || 'none'}`);
  if (r.text) console.log(`  said:  ${r.text}`);
  if (r.error) console.log(`  error: ${r.error}`);
}

const fill = (inv: Investigation) => ({ calls: inv.calls.map((c) => c.name), ms: inv.ms, text: inv.text, error: inv.ok ? undefined : inv.error });

async function main() {
  if (!['access', 'exploit', 'both'].includes(which)) throw new Error('usage: shadow <access|exploit|both> [clients...] [--all] [--out file.json]');
  const conn = await connect();
  const ask = makeAsk();
  const clients = (named.length ? named : [...conn.db.client.iter()].map((c) => c.id)).sort();
  const rows: Row[] = [];
  const all = flag('--all');
  console.log(`shadow run (no writes): ${which} on ${clients.length} clients, ${all ? 'a session for every client' : 'sessions only where the real path would call Droid'}, concurrency ${CONCURRENCY}`);

  const sage = async (clientId: string) => {
    const ctx = dryContext(conn, ask, 'access' as AgentName, clientId, 'shadow comparison');
    ctx.say = async () => {};
    const prep = await prepare(ctx);
    if (!prep) return;
    const rules = rulesChoice(prep.plan);
    const routine = !all && !needsJudgment(prep.plan);
    const row: Row = { agent: 'access', clientId, name: prep.view.client.name, routine, rules: rules.text, droid: '', agree: false, calls: [], ms: 0, text: '' };
    if (!routine) {
      const inv = await investigateSage(ctx, { plan: prep.plan, facts: sageFacts(conn, prep.view, prep.world) }, 'shadow');
      const d = droidChoice(inv.outcomes);
      Object.assign(row, { droid: inv.ok ? d.text : 'no answer', agree: inv.ok && agrees(rules, d), ...fill(inv), detail: { outcomes: inv.outcomes, calls: inv.calls, plan: { decision: prep.plan.decision?.kind, wait: prep.plan.wait?.code } } });
    }
    rows.push(row);
    show(row);
  };

  const rowan = async (clientId: string) => {
    const ctx = dryContext(conn, ask, 'exploit' as AgentName, clientId, 'shadow comparison');
    const f = rowanFacts(conn, clientId, ctx.today);
    if (!f?.exploit) return;
    const x = f.exploit;
    const verdict = (id: string) => x.verdicts.get(id)?.label ?? 'noise';
    const ruleLabels = new Map(x.findings.map((g) => [g.id, verdict(g.id)]));
    const text = (m: Map<string, string>) => [...m].filter(([, l]) => l !== 'noise').map(([id, l]) => `${id}:${l}`).join(', ') || 'no flags';
    const routine = !all && rowanWork(f) === 0;
    const row: Row = { agent: 'exploit', clientId, name: x.book.client.name, routine, rules: `${x.findings.length} findings, ${text(ruleLabels)}`, droid: '', agree: false, calls: [], ms: 0, text: '' };
    if (!routine) {
      const inv = await investigateRowan(ctx, f, 'shadow');
      const flagged = new Map(x.findings.map((g) => [g.id, 'noise']));
      for (const o of inv.outcomes) if (o.tool === 'flag_pattern' && !o.refused) flagged.set((o.args as { finding_id: string }).finding_id, (o.args as { label: string }).label);
      const differs = x.findings.filter((g) => ruleLabels.get(g.id) !== flagged.get(g.id)).map((g) => `${g.id}: rules ${ruleLabels.get(g.id)}, droid ${flagged.get(g.id)}`);
      Object.assign(row, { droid: inv.ok ? text(flagged) : 'no answer', agree: inv.ok && !differs.length, ...fill(inv), detail: { differs, outcomes: inv.outcomes, calls: inv.calls } });
    }
    rows.push(row);
    show(row);
  };

  if (which !== 'exploit') await pool(clients, CONCURRENCY, sage);
  if (which !== 'access') await pool(clients, CONCURRENCY, rowan);

  for (const agent of ['access', 'exploit']) {
    const mine = rows.filter((r) => r.agent === agent);
    if (!mine.length) continue;
    const ran = mine.filter((r) => !r.routine);
    const times = ran.map((r) => r.ms).sort((a, b) => a - b);
    const calls = ran.map((r) => r.calls.length).sort((a, b) => a - b);
    const med = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)]! : 0);
    console.log(`\n== ${agent}: ${mine.length} clients, ${ran.length} Droid sessions, ${ran.filter((r) => r.agree).length} agree, ${ran.filter((r) => !r.agree && !r.error).length} differ, ${ran.filter((r) => r.error).length} no answer`);
    console.log(`   session time median ${Math.round(med(times) / 1000)}s, max ${Math.round((times.at(-1) ?? 0) / 1000)}s · tool calls median ${med(calls)}, max ${calls.at(-1) ?? 0}`);
    console.log(`   similar_cases called in ${ran.filter((r) => r.calls.includes('similar_cases')).length} of ${ran.length} sessions`);
  }
  if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
