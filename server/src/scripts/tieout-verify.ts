/**
 * Checks the tie-out on a fully processed database, then plants a stray GL
 * line to prove an unexplained break is caught and escalated, then removes it.
 * Usage: pnpm tieout:verify  (run after pnpm sync on a fresh database)
 */
import { tables } from '../module_bindings';
import { connectStdb } from '../lib/stdb';

const { conn } = await connectStdb();
await new Promise<void>((resolve) =>
  conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([tables.tieOutRun, tables.tieOutBreak, tables.workItem, tables.ledgerEntry]),
);
const db = conn.db;
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? 'ok ' : 'BAD'} ${label}${!ok && detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const latest = () => [...db.tieOutRun.iter()].sort((a, b) => (a.id < b.id ? 1 : -1))[0];
const breaksOf = (runId: bigint) => [...db.tieOutBreak.iter()].filter((b) => b.runId === runId);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

await conn.reducers.tieOut({ trigger: 'verify' });
await wait(500);
const run = latest()!;
const breaks = breaksOf(run.id);
console.log(`Run ${run.id} (${run.simDate}): ${run.status}`);
for (const [area, v] of Object.entries(JSON.parse(run.summaryJson) as Record<string, { operations: string; ledger: string }>)) {
  console.log(`  ${area.padEnd(20)} operations ${v.operations.padStart(14)} · ledger ${v.ledger.padStart(14)}`);
}
for (const b of breaks) console.log(`  · ${b.area} ${b.kind}: ${b.detail}`);
check(run.unexplainedCents === 0n, 'Nothing unexplained: bank, ledger and receivables agree');
check(breaks.every((b) => b.kind === 'in_transit'), 'Only in-transit wires remain (gateway idle)');

console.log('\nPlanting a stray GL line (someone booked $1,234.56 directly in the ledger):');
const stray = { id: 'JE-STRAY:1', journalId: 'JE-STRAY', postedOn: run.simDate, accountCode: '1010', debitCents: 123_456n, creditCents: 0n, ref: 'STRAY', memo: 'test', source: 'treasury', workItemId: undefined };
await conn.reducers.upsertLedgerEntries({ rows: [stray] });
await conn.reducers.tieOut({ trigger: 'verify: planted break' });
await wait(800);
const broken = latest()!;
check(broken.status === 'break' && broken.unexplainedCents === 123_456n, 'Caught as an unexplained $1,234.56 break', `${broken.status} ${broken.unexplainedCents}`);
check(breaksOf(broken.id).some((b) => b.kind === 'unexplained' && b.area === 'cash:collections'), 'Located in cash: collections (1010)');
check([...db.workItem.iter()].some((w) => w.kind === 'BOOKS_BREAK' && w.state === 'PROPOSED'), 'Escalated to the controller as a work item');

conn.disconnect();
console.log(failed ? `\nFAILED: ${failed} checks` : '\nAll checks passed. (Run pnpm demo:reset to remove the planted line.)');
process.exit(failed ? 1 : 0);
