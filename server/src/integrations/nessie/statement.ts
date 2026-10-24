import type { Dataset } from '../../dataset';
import { BANK_OPENING_CENTS } from '../../dataset/gl';
import type { Bank } from './bank';
import type { NessieTransaction } from './client';
import type { SeedPlan } from './seed-plan';

/**
 * Nessie's account `balance` never moves, so balances are computed the way a
 * bank statement does: opening balance + posted transactions, with pending
 * activity shown separately. Openings come from the prior statement (the
 * dataset); every movement after that is a real Nessie record.
 */

export const PLATFORM_ACCOUNTS = ['collections', 'disbursements'] as const;

export interface Statement {
  deposits: NessieTransaction[];
  withdrawals: NessieTransaction[];
}

export interface Balance {
  postedCents: number;
  pendingInCents: number;
  pendingOutCents: number;
  availableCents: number;
  transactions: number;
}

export async function fetchStatements(bank: Bank, keys: Iterable<string>): Promise<Map<string, Statement>> {
  const out = new Map<string, Statement>();
  const all = [...new Set(keys)];
  // A few accounts at a time: Nessie has no bulk endpoint.
  for (let i = 0; i < all.length; i += 6) {
    await Promise.all(all.slice(i, i + 6).map(async (key) => {
      const acct = bank.map.accounts[key];
      if (!acct) throw new Error(`bank account "${key}" missing from seed map ${bank.map.run}`);
      const [deposits, withdrawals] = await Promise.all([bank.api.listDeposits(acct.id), bank.api.listWithdrawals(acct.id)]);
      out.set(key, { deposits, withdrawals });
    }));
  }
  return out;
}

/** Activity dated after the sim date hasn't happened yet. */
export function balanceOf(openingCents: number, s: Statement, simDate: string): Balance {
  const live = (txs: NessieTransaction[]) => txs.filter((t) => t.transaction_date <= simDate && t.status !== 'cancelled');
  const sum = (txs: NessieTransaction[], status: string) => txs.filter((t) => t.status === status).reduce((n, t) => n + t.amount, 0);
  const ins = live(s.deposits);
  const outs = live(s.withdrawals);
  const postedCents = openingCents + sum(ins, 'completed') - sum(outs, 'completed');
  const pendingOutCents = sum(outs, 'pending');
  return {
    postedCents,
    pendingInCents: sum(ins, 'pending'),
    pendingOutCents,
    availableCents: postedCents - pendingOutCents,
    transactions: ins.length + outs.length,
  };
}

/** Treasury balance kept by tier (cents): bigger clients run bigger operating accounts. */
const TIER_CUSHION = [500_000_000, 200_000_000, 100_000_000, 50_000_000, 25_000_000];

/**
 * Prior-statement balances. The platform's are the GL's opening journal plus
 * the history receipts that came before the bank window (they aren't in
 * Nessie); clients hold their tier's cushion plus enough to cover what they pay out.
 */
export function openingBalances(ds: Dataset, plan: SeedPlan): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of plan.accounts) {
    if ((PLATFORM_ACCOUNTS as readonly string[]).includes(a.key)) {
      const history = a.key === 'collections' ? ds.history.cash.filter((p) => p.rail !== 'USDC').reduce((n, p) => n + p.amountCents, 0) : 0;
      out.set(a.key, (BANK_OPENING_CENTS[a.key] ?? 0) + history);
      continue;
    }
    const tier = ds.clients.find((c) => c.id === a.key)?.tier;
    const cushion = tier ? TIER_CUSHION[tier - 1] ?? 25_000_000 : 50_000_000;
    const paidOut = plan.transactions.filter((t) => t.accountKey === a.key && t.type === 'withdrawal').reduce((n, t) => n + t.amount, 0);
    out.set(a.key, Math.ceil((paidOut * 1.5 + cushion) / 1_000_000) * 1_000_000);
  }
  return out;
}

/** Who an account belongs to: the platform, a client, or (affiliates) the parent client. */
export function accountOwner(ds: Dataset, key: string): string {
  if ((PLATFORM_ACCOUNTS as readonly string[]).includes(key)) return 'platform';
  if (key.startsWith('aff:')) return ds.affiliates.find((a) => `aff:${a.key}` === key)?.parentId ?? key;
  return key.split(':')[0]!;
}
