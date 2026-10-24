import type { DbConnection } from '../../module_bindings';
import type { BankAccount, CashMovement } from '../../module_bindings/types';
import type { RemittanceInterpreter } from '../../integrations/bank-text/interpret';
import { parseBankText } from '../../integrations/bank-text/parse';
import type { Bank } from '../../integrations/nessie/bank';
import type { NessieTransaction } from '../../integrations/nessie/client';
import { PLATFORM_ACCOUNTS, accountOwner, balanceOf, type Statement } from '../../integrations/nessie/statement';
import type { SeedPlan } from '../../integrations/nessie/seed-plan';
import type { Dataset } from '../../dataset';
import type { SyncRecord } from '../writer';

const STATUS: Record<string, string> = { completed: 'posted', pending: 'pending', cancelled: 'cancelled' };
const INBOUND = new Set(['wire_in', 'ach_collection', 'unknown']);
const OUTBOUND = new Set(['wire_out', 'ach_return', 'fee', 'unknown']);

/**
 * Raw bank text → standard fields. Rules first; Claude only for free-text
 * remittance the rules found no references in. A format we don't recognize is
 * kept (category `unknown`, confidence 0) so payment checking can escalate it.
 */
export async function toCashMovement(
  tx: NessieTransaction,
  kind: 'deposit' | 'withdrawal',
  platformAccount: string,
  interpreter?: RemittanceInterpreter,
): Promise<CashMovement> {
  const p = parseBankText(tx.description);
  if (!(kind === 'deposit' ? INBOUND : OUTBOUND).has(p.category)) {
    throw new Error(`nessie ${tx._id}: ${p.category} text on a ${kind}`);
  }
  const status = STATUS[tx.status];
  if (!status) throw new Error(`nessie ${tx._id}: unknown status "${tx.status}"`);

  let parsedBy = 'rules';
  let hintsJson = '';
  const notes = [...p.notes];
  if (kind === 'deposit' && !p.refs.length && p.remittance && interpreter) {
    const hints = await interpreter.interpret(p.remittance);
    if (hints) {
      parsedBy = 'claude';
      hintsJson = JSON.stringify(hints);
      notes.push(`Claude read the remittance: ${hints.purpose}, ${hints.periods.join(' ') || 'no period'}, ${hints.products.join(' ').toLowerCase() || 'no product'}`);
    }
  }

  return {
    id: `nessie:${tx._id}`,
    source: 'nessie',
    platformAccount,
    direction: kind === 'deposit' ? 'in' : 'out',
    rail: p.network === 'SWIFT' || p.network === 'FEDWIRE' ? 'WIRE' : p.network === 'ACH' ? 'ACH' : 'BOOK',
    amountCents: BigInt(tx.amount),
    valueOn: tx.transaction_date,
    status,
    memo: tx.description,
    category: p.category,
    network: p.network,
    origName: p.counterpartyName ?? '',
    origAccount: p.counterpartyAccount ?? '',
    remittance: p.remittance,
    refs: p.refs,
    bankRef: p.bankRef ?? `NESSIE-${tx._id}`,
    reverses: p.reverses,
    instructedCents: p.instructedCents !== undefined ? BigInt(p.instructedCents) : undefined,
    chargesCents: p.chargesCents !== undefined ? BigInt(p.chargesCents) : undefined,
    chargeBearer: p.chargeBearer,
    returnCode: p.returnCode,
    parsedBy,
    parseConfidence: p.confidence,
    parseNotes: notes.join('; '),
    hintsJson,
    rawId: `nessie:${tx._id}`,
    matchStatus: 'unmatched',
    isHistory: false,
  };
}

/**
 * The platform's bank feed: deposits and withdrawals on its own accounts.
 * Anything dated after the simulated date hasn't happened yet and is skipped.
 */
export async function bankRecords(conn: DbConnection, statements: Map<string, Statement>, simDate: string, interpreter?: RemittanceInterpreter): Promise<SyncRecord<CashMovement>[]> {
  const records: SyncRecord<CashMovement>[] = [];
  for (const key of PLATFORM_ACCOUNTS) {
    const s = statements.get(key);
    if (!s) throw new Error(`no statement for platform account "${key}"`);
    for (const [kind, list] of [['deposit', s.deposits], ['withdrawal', s.withdrawals]] as const) {
      for (const tx of list) {
        if (tx.transaction_date > simDate) continue;
        const row = await toCashMovement(tx, kind, key, interpreter);
        records.push({
          table: 'cash_movement', id: row.id, row, payload: tx, rawId: row.rawId,
          upsert: (r) => conn.reducers.upsertCashMovement({ row: r }),
        });
      }
    }
  }
  return records;
}

/** Statement balances for every account fetched in this pass. */
export function balanceRecords(
  conn: DbConnection, bank: Bank, ds: Dataset, plan: SeedPlan, openings: Map<string, number>,
  statements: Map<string, Statement>, simDate: string,
): SyncRecord<BankAccount>[] {
  const records: SyncRecord<BankAccount>[] = [];
  for (const [key, s] of statements) {
    const acct = bank.map.accounts[key]!;
    const opening = openings.get(key) ?? 0;
    const b = balanceOf(opening, s, simDate);
    const row: BankAccount = {
      id: key, owner: accountOwner(ds, key), nickname: plan.accounts.find((a) => a.key === key)?.nickname ?? key,
      accountNumber: acct.number, nessieId: acct.id, openingCents: BigInt(opening), postedCents: BigInt(b.postedCents),
      pendingInCents: BigInt(b.pendingInCents), pendingOutCents: BigInt(b.pendingOutCents), availableCents: BigInt(b.availableCents),
      transactions: b.transactions, asOf: simDate,
    };
    records.push({ table: 'bank_account', id: key, row, upsert: (r) => conn.reducers.upsertBankAccount({ row: r }) });
  }
  return records;
}
