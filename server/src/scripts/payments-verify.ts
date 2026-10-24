/**
 * Checks payment checking's results against the answer key (dataset/scenario.ts).
 * Run after `pnpm sync` on a fresh database. Usage: pnpm payments:verify
 */
import { tables } from '../module_bindings';
import { loadDataset } from '../dataset';
import { connectStdb } from '../lib/stdb';

const ds = loadDataset();
const { conn } = await connectStdb();
await new Promise<void>((resolve) =>
  conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([
    tables.invoice, tables.cashMovement, tables.paymentApplication, tables.clientCredit, tables.workItem, tables.clock,
  ]),
);
const db = conn.db;
const simDate = db.clock.id.find(1)?.simDate ?? '';
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? 'ok ' : 'BAD'} ${label}${!ok && detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

const invoices = (clientId: string, period?: string) =>
  [...db.invoice.iter()].filter((i) => i.clientId === clientId && (period ? i.period === period : i.issuedOn >= '2026-01-01'));
const allPaid = (list: { status: string }[]) => list.length > 0 && list.every((i) => i.status === 'paid');
const statuses = (list: { id: string; status: string }[]) => list.map((i) => `${i.id}:${i.status}`).join(' ');
const cash = (bankRef: string) => [...db.cashMovement.iter()].find((m) => m.bankRef === bankRef && !m.isHistory);
const items = (clientId: string, kind?: string) =>
  [...db.workItem.iter()].filter((w) => w.clientId === clientId && (!kind || w.kind === kind));
const credits = (clientId: string, kind: string) =>
  [...db.clientCredit.iter()].filter((c) => c.clientId === clientId && c.kind === kind).reduce((s, c) => s + c.amountCents, 0n);
const ref = (caseId: string) => ds.movements.find((m) => m.caseId === caseId)?.id ?? '';

console.log(`Payment checking on ${simDate}\n`);

console.log('Overnight payments, applied automatically:');
const meridian = invoices('ORG-90142', '2026-01');
check(allPaid(meridian), 'Meridian: January invoices paid', statuses(meridian));
const granite = invoices('ORG-90391', '2026-01');
check(allPaid(granite), 'Granite Bay: both invoices paid despite $25 short', statuses(granite));
check([...db.paymentApplication.iter()].some((a) => a.method === 'short_fee' && a.amountCents === 2500n && a.policyRef === 'pol-002'),
  'Granite Bay: $25.00 written off to bank fees under pol-002');
const fieldstone = invoices('ORG-90229').filter((i) => i.period !== '2026-02');
check(allPaid(fieldstone) && fieldstone.length === 6, 'Fieldstone: lump sum paid all 6 Dec + Jan invoices', statuses(fieldstone));
check(invoices('ORG-90229', '2026-02').every((i) => i.status === 'open'), 'Fieldstone: February left open');
check(allPaid(invoices('ORG-90366', '2026-01')), 'Copperline: no-reference wire matched by account and amount');
const basaltItem = items('ORG-90244', 'PAYMENT_MATCH')[0];
check(allPaid(invoices('ORG-90244', '2026-01')) && basaltItem?.policyRef === 'pol-004', 'Basalt: feeder fund wire applied to parent (pol-004)', basaltItem?.policyRef);
check(allPaid(invoices('ORG-90176', '2026-01')) && credits('ORG-90176', 'overpayment') === 100_000n, 'Northfold: paid, $1,000.00 held as credit');
check(allPaid(invoices('ORG-90251', '2026-01')) && invoices('ORG-90251', '2026-02').every((i) => i.status === 'open'),
  "Cinder Peak: wrong references → January paid, February open");
check(allPaid(invoices('ORG-90612', '2026-01')), 'Saltmarsh: Feb 19 wire found and applied');
check(allPaid(invoices('ORG-90164', '2026-01')) && cash(`TX-${ds.onchain.find((p) => p.clientId === 'ORG-90164')!.txHash.slice(2, 10)}`)?.matchStatus === 'matched',
  'Silverline: USDC matched by wallet');

console.log('\nTraps:');
const wren = invoices('ORG-90744', '2026-01')[0];
check(wren?.status === 'partially_paid' && wren.amountCents - wren.paidCents === 645_000n, 'Wrenfield: half paid, $6,450.00 still due', `${wren?.status} ${wren?.paidCents}`);
const quillon = invoices('ORG-90689', '2026-01')[0];
check(quillon?.status === 'open' && quillon.paidCents === 0n, 'Quillon: bounced ACH reversed, invoice reopened', `${quillon?.status} ${quillon?.paidCents}`);
check(items('ORG-90689', 'PAYMENT_REVERSAL').length === 1, 'Quillon: reversal recorded as a work item');
const dup = cash(ref('duplicate-wire') === 'WI-5404' ? 'WI-5407' : ref('duplicate-wire'));
check(allPaid(invoices('ORG-90431', '2026-01')) && items('ORG-90431', 'REFUND').length === 1, 'Ostrava: second wire flagged, refund proposed to controller');
check(dup?.matchStatus === 'exception' && credits('ORG-90431', 'unapplied_cash') === 4_052_000n, 'Ostrava: duplicate held as unapplied cash');
check(cash(ref('in-transit'))?.matchStatus === 'in_transit' && invoices('ORG-90463', '2026-01').every((i) => i.status === 'open'),
  'Ivory Lane: wire in transit, invoices untouched');
const harbor = items('ORG-90378', 'PAYMENT_MATCH')[0];
check(harbor?.state === 'PROPOSED' && invoices('ORG-90378', '2026-01').every((i) => i.status === 'open'),
  'Harbor & Pine: new account → proposed for accountant, not applied', harbor?.state);
check([...db.workItem.iter()].some((w) => w.kind === 'UNIDENTIFIED_CASH' && w.state === 'PROPOSED'), 'Unknown wallet: sent to accountant');
const kestrel = invoices('ORG-90412', '2026-01');
check(kestrel.filter((i) => i.status === 'open').reduce((s, i) => s + i.amountCents, 0n) === 14_820_000n && kestrel.some((i) => i.status === 'disputed'),
  'Kestrel: $148,200.00 open, overage protected as disputed');

console.log('\nIntegrity:');
const bad = [...db.invoice.iter()].filter((i) => i.paidCents < 0n || i.paidCents > i.amountCents);
check(bad.length === 0, 'No invoice paid below zero or above its amount', bad.map((i) => i.id).join(' '));
const history = ['ORG-90101', 'ORG-90107', 'ORG-90118', 'ORG-90302'];
check(history.every((c) => allPaid(invoices(c, '2026-01')) && items(c).length === 0),
  'Cash billing had already applied reconciles quietly (no duplicate work)');
const historyCash = [...db.cashMovement.iter()].filter((m) => m.isHistory);
check(historyCash.length > 0 && historyCash.every((m) => m.matchStatus === 'matched'), `All ${historyCash.length} history payments reconciled`);
const historyIds = new Set(historyCash.map((m) => m.id));
check([...db.workItem.iter()].every((w) => !historyIds.has(w.subjectId)), 'History created no work items');
const historyInvoices = [...db.invoice.iter()].filter((i) => i.issuedOn < '2026-01-01' && i.status === 'paid');
check(historyInvoices.length > 0 && historyInvoices.every((i) => i.paidOn), 'Every paid invoice has a paid date');
const stillClaimable = [...db.invoice.iter()].filter((i) => i.paidOn && i.paidOn < '2026-02-01' && i.status !== 'paid');
check(stillClaimable.length === 0, 'No history invoice reopened by matching', stillClaimable.map((i) => i.id).join(' '));
const human = [...db.workItem.iter()].filter((w) => w.state === 'PROPOSED');
const auto = [...db.workItem.iter()].filter((w) => w.autoApplied);
console.log(`\n${auto.length} handled automatically, ${human.length} need a person:`);
for (const w of human) console.log(`  · [${w.requiredRole}] ${w.title}`);

conn.disconnect();
console.log(failed ? `\nFAILED: ${failed} checks` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
