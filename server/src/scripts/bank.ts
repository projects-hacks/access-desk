/**
 * Day-to-day bank operations against a seeded run.
 *
 *   pnpm bank show [ORG-xxxxx|collections|disbursements]   print an account's bills and transactions
 *   pnpm bank settle <movementId>                          post a pending wire, e.g. WI-5531 (both sides)
 *   pnpm bank reset                                        put the bank back exactly as seeded
 *
 * Add `--run demo` to target another run (default: dev).
 */
import { parseArgs } from 'node:util';
import { loadDataset } from '../dataset';
import { env } from '../lib/env';
import { NessieClient } from '../integrations/nessie/client';
import { readSeedMap } from '../integrations/nessie/seed-map';
import { buildSeedPlan } from '../integrations/nessie/seed-plan';
import { resetBank, settleWire } from '../integrations/nessie/reset';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { run: { type: 'string', default: 'dev' } },
});
const [command, arg] = positionals;

if (!env.NESSIE_API_KEY) throw new Error('NESSIE_API_KEY is not set');
const nessie = new NessieClient(env.NESSIE_BASE_URL, env.NESSIE_API_KEY);
const map = readSeedMap(values.run);
const plan = buildSeedPlan(loadDataset());
const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

switch (command) {
  case 'show':
    await show(arg ?? 'collections');
    break;
  case 'settle':
    if (!arg) throw new Error('usage: pnpm bank settle <movementId>');
    await settle(arg);
    break;
  case 'reset':
    await reset();
    break;
  default:
    console.log('usage: pnpm bank <show|settle|reset> [arg] [--run dev]');
}

async function show(accountKey: string) {
  const acct = map.accounts[accountKey];
  if (!acct) throw new Error(`no account "${accountKey}" in run ${values.run}`);
  const [deposits, withdrawals, bills] = await Promise.all([
    nessie.listDeposits(acct.id),
    nessie.listWithdrawals(acct.id),
    nessie.listBills(acct.id),
  ]);
  console.log(`${accountKey} · account ${acct.number}\n`);
  const rows = [
    ...deposits.map((t) => ({ ...t, sign: '+' })),
    ...withdrawals.map((t) => ({ ...t, sign: '-' })),
  ].sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
  for (const t of rows) {
    console.log(`${t.transaction_date} ${t.status.padEnd(9)} ${t.sign}${usd(t.amount).padStart(15)}  ${t.description}`);
  }
  if (bills.length) {
    console.log('\nBills presented:');
    for (const b of bills.sort((x, y) => x.nickname.localeCompare(y.nickname))) {
      console.log(`  ${b.status.padEnd(9)} $${b.payment_amount.toFixed(2).padStart(12)}  due ${b.payment_date}  ${b.nickname}`);
    }
  }
}

async function settle(movementId: string) {
  const ok = await settleWire(nessie, map, plan, movementId);
  console.log(ok ? `${movementId}: completed on both sides` : `${movementId}: not found in run ${values.run}`);
}

async function reset() {
  const { restored, deleted } = await resetBank(nessie, map, plan);
  console.log(`Bank reset for run "${values.run}": ${restored} restored, ${deleted} deleted.`);
}
