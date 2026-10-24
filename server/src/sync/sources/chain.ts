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
      const origName = p.clientId ? ds.clients.find((c) => c.id === p.clientId)?.legalName.toUpperCase() : undefined;
      const row: CashMovement = {
        id: `chain:${p.txHash}`,
        source: 'chain',
        platformAccount: 'wallet',
        direction: 'in',
        rail: 'USDC',
        amountCents: BigInt(p.amountCents),
        valueOn: p.valueDate,
        status: 'posted',
        // On-chain transfers carry no memo. Travel Rule data names the originator only for known counterparties.
        memo: `USDC TRANSFER IN NETWORK:BASE TX:${p.txHash} FROM:${p.wallet} TRAVEL RULE ORIG:${origName ?? 'NONE (UNHOSTED WALLET)'}`,
        category: 'usdc_in',
        network: 'USDC',
        origName: '',
        origAccount: p.wallet,
        remittance: '',
        refs: [],
        bankRef: `TX-${p.txHash.slice(2, 10)}`,
        reverses: undefined,
        instructedCents: undefined,
        chargesCents: undefined,
        chargeBearer: undefined,
        returnCode: undefined,
        parsedBy: 'rules',
        parseConfidence: 1,
        parseNotes: origName ? '' : 'No Travel Rule originator: unhosted wallet',
        hintsJson: '',
        rawId: `chain:${p.txHash}`,
        matchStatus: 'unmatched',
        isHistory: false,
      };
      return { table: 'cash_movement', id: row.id, row, payload: p, rawId: row.rawId, upsert: (r) => conn.reducers.upsertCashMovement({ row: r }) };
    });
}
