import type { LedgerEntry } from '../../module_bindings/types';
import type { PlatformSimulator } from '../../platform/simulator';

/** General ledger lines, one row per journal line, id `<journalId>:<line>`. */
export function glRows(sim: PlatformSimulator): LedgerEntry[] {
  const rows: LedgerEntry[] = [];
  for (const j of sim.journals.values()) {
    j.lines.forEach((l, n) => {
      rows.push({
        id: `${j.journalId}:${n + 1}`, journalId: j.journalId, postedOn: j.postedOn, accountCode: l.account,
        debitCents: BigInt(l.debitCents), creditCents: BigInt(l.creditCents), ref: j.ref, memo: j.memo,
        source: j.source, workItemId: undefined,
      });
    });
  }
  return rows;
}
