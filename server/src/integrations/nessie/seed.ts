import type { NessieApi } from './client';
import type { SeedMap } from './seed-map';
import type { AccountKey, SeedPlan } from './seed-plan';

interface SeedOptions {
  concurrency?: number;
  /** Called after every created record (persist the map, report progress). */
  onProgress?: (step: string, done: number, total: number) => void;
}

/**
 * Creates every planned record that isn't in `map` yet, filling `map` as it goes.
 * Safe to re-run: anything already created is skipped.
 */
export async function seedBank(api: NessieApi, plan: SeedPlan, map: SeedMap, opts: SeedOptions = {}) {
  const concurrency = opts.concurrency ?? 5;
  const account = (key: AccountKey) => {
    const acct = map.accounts[key];
    if (!acct) throw new Error(`account ${key} missing`);
    return acct;
  };

  async function step<T>(name: string, items: T[], run: (item: T) => Promise<void>) {
    let done = 0;
    const queue = [...items];
    const worker = async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await run(item);
        opts.onProgress?.(name, ++done, items.length);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  await step('customers', plan.customers.filter((c) => !map.customers[c.key]), async ({ key, ...body }) => {
    map.customers[key] = (await api.createCustomer(body))._id;
  });

  await step('accounts', plan.accounts.filter((a) => !map.accounts[a.key]), async (a) => {
    const customerId = map.customers[a.customerKey];
    if (!customerId) throw new Error(`customer ${a.customerKey} missing`);
    const acct = await api.createAccount(customerId, { type: 'Checking', nickname: a.nickname, rewards: 0, balance: 0 });
    map.accounts[a.key] = { id: acct._id, number: acct.account_number };
  });

  await step('bills', plan.bills.filter((b) => !map.bills[b.key]), async ({ key, accountKey, ...body }) => {
    map.bills[key] = (await api.createBill(account(accountKey).id, body))._id;
  });

  // Chronological, so each account's history reads in order.
  const transactions = plan.transactions
    .filter((t) => !map.transactions[t.key])
    .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
  await step('transactions', transactions, async (t) => {
    const body = {
      medium: 'balance',
      transaction_date: t.transaction_date,
      status: t.status,
      amount: t.amount,
      description: t.describe((key) => account(key).number),
    };
    const id = account(t.accountKey).id;
    const created = t.type === 'deposit' ? await api.createDeposit(id, body) : await api.createWithdrawal(id, body);
    map.transactions[t.key] = created._id;
  });
}
