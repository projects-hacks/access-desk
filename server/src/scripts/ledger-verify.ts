/**
 * Checks the books: journals balance, our ledger equals the platform's GL,
 * every cash decision is booked, and billing agrees with us once the gateway
 * is idle. Usage: pnpm ledger:verify
 */
import { tables } from '../module_bindings';
import { loadDataset } from '../dataset';
import { ACCOUNT_NAMES } from '../dataset/gl';
import { openPlatform } from '../platform/bootstrap';
import { connectStdb } from '../lib/stdb';

const ds = loadDataset();
const { conn } = await connectStdb();
const platform = await openPlatform(conn, ds);
await new Promise<void>((resolve) =>
  conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([
    tables.ledgerEntry, tables.cashMovement, tables.paymentApplication, tables.invoice, tables.gatewayCommand,
  ]),
);
const db = conn.db;
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? 'ok ' : 'BAD'} ${label}${!ok && detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const usd = (c: bigint) => `${c < 0n ? '-' : ''}$${((c < 0n ? -c : c) / 100n).toLocaleString('en-US')}.${((c < 0n ? -c : c) % 100n).toString().padStart(2, '0')}`;

const lines = [...db.ledgerEntry.iter()];
const journals = new Map<string, typeof lines>();
for (const l of lines) journals.set(l.journalId, [...(journals.get(l.journalId) ?? []), l]);

console.log('Gateway:');
const stuck = [...db.gatewayCommand.iter()].filter((c) => c.status !== 'done');
check(stuck.length === 0, 'Every command executed', stuck.map((c) => `${c.type}:${c.status}`).join(' '));

console.log('\nJournals:');
const unbalanced = [...journals.entries()].filter(([, ls]) => ls.reduce((s, l) => s + l.debitCents - l.creditCents, 0n) !== 0n);
check(unbalanced.length === 0, `${journals.size} journals, every one balances`, unbalanced.map(([id]) => id).join(' '));
const tb = new Map<string, bigint>();
for (const l of lines) tb.set(l.accountCode, (tb.get(l.accountCode) ?? 0n) + l.debitCents - l.creditCents);
check([...tb.values()].reduce((a, b) => a + b, 0n) === 0n, 'Trial balance sums to zero');
const glLines = [...platform.journals.values()].reduce((s, j) => s + j.lines.length, 0);
check(lines.length === glLines, `Our ledger matches the platform GL line for line (${lines.length})`, `${lines.length} vs ${glLines}`);

console.log('\nEvery cash decision is booked:');
const refs = new Set(lines.map((l) => l.ref));
const live = [...db.cashMovement.iter()].filter((m) => !m.isHistory && m.status === 'posted');
const unbooked = live.filter((m) => !refs.has(m.bankRef));
check(unbooked.length === 0, `All ${live.length} posted bank and chain movements have journals`, unbooked.map((m) => m.bankRef).join(' '));
const ours = [...db.paymentApplication.iter()].filter((a) => a.method !== 'prior' && !a.reversed);
check(ours.every((a) => a.posted), `All ${ours.length} of our applications confirmed by billing`);
const byJournal = (prefix: string) => [...journals.keys()].filter((j) => j.startsWith(prefix));
const writeOffLines = byJournal('JE-AP-').flatMap((j) => journals.get(j)!).filter((l) => l.accountCode === '6850');
check(writeOffLines.length === 1 && writeOffLines[0]!.debitCents === 2500n, 'Granite Bay: exactly $25.00 written off to 6850 Bank fees',
  writeOffLines.map((l) => `${l.journalId} ${l.debitCents}`).join(' '));
const fees = tb.get('6850') ?? 0n;
const bankFees = [...db.cashMovement.iter()].filter((m) => m.memo.startsWith('BANK FEE')).reduce((s, m) => s + m.amountCents, 0n);
check(fees === bankFees + 2500n, `6850 Bank fees = bank's fee debits + the $25.00 write-off (${usd(fees)})`);
const ret = [...db.cashMovement.iter()].find((m) => m.reverses);
const retLines = ret ? lines.filter((l) => l.ref === ret.bankRef) : [];
check(retLines.some((l) => l.accountCode === '1200' && l.debitCents === ret!.amountCents) && retLines.some((l) => l.accountCode === '1010' && l.creditCents === ret!.amountCents),
  'Quillon: ACH return booked (receivables reopened, cash out)');

console.log('\nBilling agrees with us:');
const disagree = [...db.invoice.iter()].filter((i) => {
  const billing = platform.invoices.get(i.id);
  return !billing || BigInt(billing.paidCents) !== i.paidCents || i.sourcePaidCents !== i.paidCents;
});
check(disagree.length === 0, 'Every invoice: our paid amount = billing\'s', disagree.slice(0, 5).map((i) => `${i.id} ours ${i.paidCents} billing ${platform.invoices.get(i.id)?.paidCents}`).join('; '));

console.log('\nTrial balance:');
for (const [account, bal] of [...tb.entries()].sort()) console.log(`  ${account} ${(ACCOUNT_NAMES[account] ?? '').padEnd(28)} ${usd(bal).padStart(18)}`);

conn.disconnect();
console.log(failed ? `\nFAILED: ${failed} checks` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
