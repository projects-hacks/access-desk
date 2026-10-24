import type { DbConnection } from '../../module_bindings';
import type { CashMovement } from '../../module_bindings/types';
import type { Bank } from '../../integrations/nessie/bank';
import type { NessieTransaction } from '../../integrations/nessie/client';
import { memoRefs, parseMemo } from '../../integrations/nessie/memo';
import type { SyncRecord } from '../writer';

const PLATFORM_ACCOUNTS = ['collections', 'disbursements'] as const;

/** Memo type → direction and rail. Every type the seed writes is listed; anything else is an error. */
const MEMO_TYPES: Record<string, { direction: 'in' | 'out'; rail: 'WIRE' | 'ACH' | 'BOOK' }> = {
  'WIRE IN': { direction: 'in', rail: 'WIRE' },
  'ACH IN': { direction: 'in', rail: 'ACH' },
  'WIRE OUT': { direction: 'out', rail: 'WIRE' },
  'ACH RETURN R01 NSF': { direction: 'out', rail: 'ACH' },
  'BANK FEE': { direction: 'out', rail: 'BOOK' },
};

const STATUS: Record<string, string> = { completed: 'posted', pending: 'pending', cancelled: 'cancelled' };

export function toCashMovement(
  tx: NessieTransaction,
  kind: 'deposit' | 'withdrawal',
  platformAccount: string,
): CashMovement {
  const memo = parseMemo(tx.description);
  const type = MEMO_TYPES[memo.type];
  if (!type) throw new Error(`unknown memo type "${memo.type}" on nessie ${tx._id}`);
  if ((type.direction === 'in') !== (kind === 'deposit')) {
    throw new Error(`memo "${memo.type}" on a ${kind} (nessie ${tx._id})`);
  }
  const status = STATUS[tx.status];
  if (!status) throw new Error(`unknown status "${tx.status}" on nessie ${tx._id}`);
  const bankRef = memo.fields.ID;
  if (!bankRef) throw new Error(`memo without ID on nessie ${tx._id}`);
  return {
    id: `nessie:${tx._id}`,
    source: 'nessie',
    platformAccount,
    direction: type.direction,
    rail: type.rail,
    amountCents: BigInt(tx.amount),
    valueOn: tx.transaction_date,
    status,
    memo: tx.description,
    origName: memo.fields.ORIG ?? memo.fields.BENE ?? memo.fields.DESC ?? '',
    origAccount: memo.fields.ORIG_ACCT ?? memo.fields.BENE_ACCT ?? '',
    refs: memoRefs(memo),
    bankRef,
    reverses: memo.fields.ORIG_ID,
    rawId: `nessie:${tx._id}`,
    matchStatus: 'unmatched',
    isHistory: false,
  };
}

/**
 * The platform's bank feed: deposits and withdrawals on its own accounts.
 * Anything dated after the simulated date hasn't happened yet and is skipped.
 */
export async function bankRecords(conn: DbConnection, bank: Bank, simDate: string): Promise<SyncRecord<CashMovement>[]> {
  const records: SyncRecord<CashMovement>[] = [];
  for (const key of PLATFORM_ACCOUNTS) {
    const acct = bank.map.accounts[key];
    if (!acct) throw new Error(`platform account "${key}" missing from seed map ${bank.map.run}`);
    const [deposits, withdrawals] = await Promise.all([bank.api.listDeposits(acct.id), bank.api.listWithdrawals(acct.id)]);
    for (const [kind, list] of [['deposit', deposits], ['withdrawal', withdrawals]] as const) {
      for (const tx of list) {
        if (tx.transaction_date > simDate) continue;
        const row = toCashMovement(tx, kind, key);
        records.push({
          table: 'cash_movement', id: row.id, row, payload: tx, rawId: row.rawId,
          upsert: (r) => conn.reducers.upsertCashMovement({ row: r }),
        });
      }
    }
  }
  return records;
}
