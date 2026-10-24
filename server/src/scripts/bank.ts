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
import { NessieClient, type NessieTransaction } from '../integrations/nessie/client';
import { readSeedMap } from '../integrations/nessie/seed-map';
import { buildSeedPlan } from '../integrations/nessie/seed-plan';

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

/** Posts a pending wire on both sides, as the bank would. */
async function settle(movementId: string) {
  for (const side of ['platform', 'counterparty'] as const) {
    const t = plan.transactions.find((x) => x.movementId === movementId && x.side === side);
    const id = map.transactions[`${movementId}:${side}`];
    if (!t || !id) continue;
    const update = t.type === 'deposit' ? nessie.updateDeposit.bind(nessie) : nessie.updateWithdrawal.bind(nessie);
    await update(id, { status: 'completed' });
    console.log(`${movementId} ${side}: completed`);
  }
}

/** Restores seeded statuses and deletes anything created after the seed (live demo activity). */
async function reset() {
  const seededTx = new Map(Object.entries(map.transactions).map(([key, id]) => [id, key]));
  const seededBills = new Map(Object.entries(map.bills).map(([key, id]) => [id, key]));
  const txPlan = new Map(plan.transactions.map((t) => [t.key, t]));
  const billPlan = new Map(plan.bills.map((b) => [b.key, b]));
  let restored = 0;
  let deleted = 0;

  await Promise.all(
    Object.values(map.accounts).map(async (acct) => {
      const [deposits, withdrawals, bills] = await Promise.all([
        nessie.listDeposits(acct.id),
        nessie.listWithdrawals(acct.id),
        nessie.listBills(acct.id),
      ]);
      const check = async (t: NessieTransaction, kind: 'deposit' | 'withdrawal') => {
        const key = seededTx.get(t._id);
        const planned = key ? txPlan.get(key) : undefined;
        if (!planned) {
          await (kind === 'deposit' ? nessie.deleteDeposit(t._id) : nessie.deleteWithdrawal(t._id));
          deleted++;
        } else if (t.status !== planned.status || t.transaction_date !== planned.transaction_date) {
          const body = { status: planned.status, transaction_date: planned.transaction_date };
          await (kind === 'deposit' ? nessie.updateDeposit(t._id, body) : nessie.updateWithdrawal(t._id, body));
          restored++;
        }
      };
      for (const t of deposits) await check(t, 'deposit');
      for (const t of withdrawals) await check(t, 'withdrawal');
      for (const b of bills) {
        const key = seededBills.get(b._id);
        const planned = key ? billPlan.get(key) : undefined;
        if (!planned) {
          await nessie.deleteBill(b._id);
          deleted++;
        } else if (b.status !== planned.status) {
          await nessie.updateBill(b._id, { status: planned.status });
          restored++;
        }
      }
    }),
  );
  console.log(`Bank reset for run "${values.run}": ${restored} restored, ${deleted} deleted.`);
}
