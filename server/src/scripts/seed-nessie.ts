/**
 * Seeds the platform's bank (Nessie) from the demo dataset.
 *
 *   pnpm seed:nessie                       dry run: print the plan and the story
 *   pnpm seed:nessie --apply               create records for run "dev" (resumes if interrupted)
 *   pnpm seed:nessie --apply --run demo    a separate run with its own customers
 *
 * Created ids are saved to .data/nessie-<run>.json; sync and reset read that file.
 *
 * Nessie data is public and customers can't be deleted, so a reset means a
 * fresh run, never a cleanup.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadDataset } from '../dataset';
import { daysBetween } from '../dataset/dates';
import { env } from '../lib/env';
import { NessieClient } from '../integrations/nessie/client';
import { buildSeedPlan, type AccountKey, type SeedPlan } from '../integrations/nessie/seed-plan';
import { seedBank } from '../integrations/nessie/seed';
import { DATA_DIR, emptySeedMap, readSeedMap, seedMapPath, writeSeedMap } from '../integrations/nessie/seed-map';

const PLAN_FILE = join(DATA_DIR, 'nessie-plan.json');
const CONCURRENCY = 5;

const { values: args } = parseArgs({
  options: { apply: { type: 'boolean', default: false }, run: { type: 'string', default: 'dev' } },
});
const apply = args.apply;
const run = args.run;

const ds = loadDataset();
const plan = buildSeedPlan(ds);
mkdirSync(DATA_DIR, { recursive: true });

if (!apply) {
  writeFileSync(PLAN_FILE, JSON.stringify(renderPlan(plan, (k) => `<${k}>`), null, 2));
  printStory();
  console.log(`\nDry run only. Full plan: ${PLAN_FILE}\nRun with --apply to create these records in Nessie.`);
  process.exit(0);
}

if (!env.NESSIE_API_KEY) throw new Error('NESSIE_API_KEY is not set');
const nessie = new NessieClient(env.NESSIE_BASE_URL, env.NESSIE_API_KEY);
const map = existsSync(seedMapPath(run)) ? readSeedMap(run) : emptySeedMap(run, env.NESSIE_BASE_URL);
console.log(`Seeding run "${run}" into ${env.NESSIE_BASE_URL}`);
await seedBank(nessie, plan, map, {
  concurrency: CONCURRENCY,
  onProgress: (step, done, total) => {
    writeSeedMap(map);
    process.stdout.write(`\r${step}: ${done}/${total}${done === total ? '\n' : ''}`);
  },
});
writeSeedMap(map);
console.log(`Done. Created Nessie ids: ${seedMapPath(run)}`);

function renderPlan(p: SeedPlan, acct: (k: AccountKey) => string) {
  return { ...p, transactions: p.transactions.map(({ describe, ...t }) => ({ ...t, description: describe(acct) })) };
}

function printStory() {
  const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const clientName = (id: string) => ds.clients.find((c) => c.id === id)?.name ?? id;
  const deposits = plan.transactions.filter((t) => t.side === 'platform');

  console.log(`${ds.platform.name} · bank seed for sim date ${ds.simDate} (window from ${ds.bankWindowStart})\n`);
  console.log(`Nessie records: ${plan.customers.length} customers · ${plan.accounts.length} accounts · ${plan.bills.length} bills · ${plan.transactions.length} deposits/withdrawals (${deposits.length} on the platform side)`);
  console.log(`Total requests: ${plan.customers.length + plan.accounts.length + plan.bills.length + plan.transactions.length}\n`);

  console.log('Receivables on the morning of the demo (billing view, before matching):');
  for (const c of ds.clients) {
    const open = ds.invoices.filter((i) => i.clientId === c.id && i.status !== 'paid' && i.dueOn <= ds.simDate);
    if (!open.length) continue;
    const owed = open.reduce((s, i) => s + i.amountCents - i.paidCents, 0);
    const oldest = open.reduce((d, i) => Math.max(d, daysBetween(i.dueOn, ds.simDate)), 0);
    const disputed = open.some((i) => i.status === 'disputed') ? ' (incl. disputed)' : '';
    const age = oldest === 0 ? 'due today' : `${oldest}d past due`;
    console.log(`  ${c.name.padEnd(24)} T${c.tier}  ${usd(owed).padStart(14)}  ${age.padStart(12)}${disputed}`);
  }

  console.log('\nPlanted cases:');
  for (const k of ds.cases) {
    console.log(`\n  [${k.id}]${k.demoStep ? ` demo step ${k.demoStep}` : ''} · ${clientName(k.clientId)} · ${k.title}`);
    console.log(`    expected: ${k.expected}`);
    for (const t of deposits.filter((x) => ds.movements.find((m) => m.id === x.movementId)?.caseId === k.id)) {
      console.log(`    ${t.type === 'deposit' ? '+' : '-'}${usd(t.amount)} ${t.transaction_date} ${t.status.padEnd(9)} ${t.describe((key) => `<${key}>`)}`);
    }
    for (const p of ds.onchain.filter((x) => x.caseId === k.id)) {
      console.log(`    on-chain +${usd(p.amountCents)} USDC ${p.valueDate} from ${p.wallet.slice(0, 8)}… refs ${p.refs.join(' ') || '(none)'}`);
    }
  }

  console.log('\nOther bank activity:');
  for (const t of deposits.filter((x) => !ds.movements.find((m) => m.id === x.movementId)?.caseId)) {
    console.log(`  ${t.type === 'deposit' ? '+' : '-'}${usd(t.amount).padStart(15)} ${t.transaction_date} ${t.describe((key) => `<${key}>`)}`);
  }
}
