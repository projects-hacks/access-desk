import { randomUUID } from 'node:crypto';
import type { NessieAccount, NessieApi, NessieBill, NessieCustomer, NessieTransaction } from './client';
import { seedBank } from './seed';
import { emptySeedMap, type SeedMap } from './seed-map';
import type { SeedPlan } from './seed-plan';

type Tx = NessieTransaction & { accountId: string; kind: 'deposit' | 'withdrawal' };
type Bill = NessieBill & { accountId: string };

/**
 * In-memory stand-in for Nessie with the same interface. Used for fast tests,
 * and as a fallback if Nessie is down during judging (BANK_MODE=fake).
 * Like Nessie, balances never move and nothing settles on its own.
 */
export class FakeNessie implements NessieApi {
  private customers = new Map<string, NessieCustomer>();
  private accounts = new Map<string, NessieAccount>();
  private bills = new Map<string, Bill>();
  private txs = new Map<string, Tx>();
  private nextAccountNumber = 4_000_000_000_000_000;

  /** A fake bank already holding the full seed, plus the id map to find things in it. */
  static async seeded(plan: SeedPlan, run = 'fake'): Promise<{ bank: FakeNessie; map: SeedMap }> {
    const bank = new FakeNessie();
    const map = emptySeedMap(run, 'memory://fake-nessie');
    await seedBank(bank, plan, map, { concurrency: 1 });
    return { bank, map };
  }

  async createCustomer(body: Omit<NessieCustomer, '_id'>) {
    const customer = { _id: randomUUID(), ...body };
    this.customers.set(customer._id, customer);
    return customer;
  }

  async createAccount(customerId: string, body: { type: NessieAccount['type']; nickname: string }) {
    const acct: NessieAccount = {
      _id: randomUUID(),
      type: body.type,
      nickname: body.nickname,
      account_number: String(this.nextAccountNumber++),
      customer_id: customerId,
    };
    this.accounts.set(acct._id, acct);
    return acct;
  }

  async getAccount(id: string) {
    const acct = this.accounts.get(id);
    if (!acct) throw new Error(`fake nessie: account ${id} not found`);
    return acct;
  }

  async createBill(accountId: string, body: Omit<NessieBill, '_id'>) {
    const bill: Bill = { _id: randomUUID(), accountId, ...body };
    this.bills.set(bill._id, bill);
    return strip(bill);
  }

  async updateBill(id: string, body: Partial<Omit<NessieBill, '_id'>>) {
    return this.patch(this.bills, id, body);
  }

  async listBills(accountId: string) {
    return [...this.bills.values()].filter((b) => b.accountId === accountId).map(strip);
  }

  async deleteBill(id: string) {
    this.bills.delete(id);
  }

  createDeposit(accountId: string, body: Omit<NessieTransaction, '_id'>) {
    return this.createTx(accountId, 'deposit', body);
  }

  createWithdrawal(accountId: string, body: Omit<NessieTransaction, '_id'>) {
    return this.createTx(accountId, 'withdrawal', body);
  }

  async listDeposits(accountId: string) {
    return this.listTx(accountId, 'deposit');
  }

  async listWithdrawals(accountId: string) {
    return this.listTx(accountId, 'withdrawal');
  }

  async updateDeposit(id: string, body: Partial<Omit<NessieTransaction, '_id'>>) {
    return this.patch(this.txs, id, body);
  }

  async updateWithdrawal(id: string, body: Partial<Omit<NessieTransaction, '_id'>>) {
    return this.patch(this.txs, id, body);
  }

  async deleteDeposit(id: string) {
    this.txs.delete(id);
  }

  async deleteWithdrawal(id: string) {
    this.txs.delete(id);
  }

  private async createTx(accountId: string, kind: Tx['kind'], body: Omit<NessieTransaction, '_id'>) {
    const tx: Tx = { _id: randomUUID(), accountId, kind, ...body };
    this.txs.set(tx._id, tx);
    return strip(tx);
  }

  private listTx(accountId: string, kind: Tx['kind']) {
    return [...this.txs.values()].filter((t) => t.accountId === accountId && t.kind === kind).map(strip);
  }

  private patch<T extends object>(store: Map<string, T>, id: string, body: Partial<T>) {
    const row = store.get(id);
    if (!row) throw new Error(`fake nessie: ${id} not found`);
    store.set(id, { ...row, ...body });
    return 'Accepted update';
  }
}

function strip<T extends { accountId: string }>(row: T): Omit<T, 'accountId' | 'kind'> {
  const { accountId: _a, kind: _k, ...rest } = row as T & { kind?: unknown };
  return rest;
}
