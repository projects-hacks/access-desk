import type { DbConnection } from '../../module_bindings';
import type { CashMovement } from '../../module_bindings/types';
import type { Dataset } from '../../dataset';
import type { SyncRecord } from '../writer';

/**
 * Incoming USDC to the platform's wallet. On-chain transfers carry no
 * reference, so refs stay empty: matching works from wallet and amount.
 */
export function chainRecords(conn: DbConnection, ds: Dataset, simDate: string): SyncRecord<CashMovement>[] {
  return ds.onchain
    .filter((p) => p.valueDate <= simDate)
    .map((p) => {
      const row: CashMovement = {
        id: `chain:${p.txHash}`,
        source: 'chain',
        platformAccount: 'wallet',
        direction: 'in',
        rail: 'USDC',
        amountCents: BigInt(p.amountCents),
        valueOn: p.valueDate,
        status: 'posted',
        memo: `USDC IN | FROM: ${p.wallet} | TX: ${p.txHash}`,
        origName: '',
        origAccount: p.wallet,
        refs: [],
        bankRef: `TX-${p.txHash.slice(2, 10)}`,
        reverses: undefined,
        rawId: `chain:${p.txHash}`,
        matchStatus: 'unmatched',
        isHistory: false,
      };
      return { table: 'cash_movement', id: row.id, row, payload: p, rawId: row.rawId, upsert: (r) => conn.reducers.upsertCashMovement({ row: r }) };
    });
}
