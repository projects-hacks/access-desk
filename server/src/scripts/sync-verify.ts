/**
 * Checks the shared database against the sources after a sync. Exit code 1 on any failure.
 * Usage: pnpm sync:verify
 */
import { tables } from '../module_bindings';
import { loadDataset } from '../dataset';
import {
  capabilities, clausesFor, disputes, holdingsFor, leversFor, owedToClient, positionsFor,
} from '../dataset/platform-data';
import { openBank } from '../integrations/nessie/bank';
import { bankRecords } from '../sync/sources/bank';
import { chainRecords } from '../sync/sources/chain';
import { historyRecords } from '../sync/sources/history';
import { buildSeedPlan } from '../integrations/nessie/seed-plan';
import { env } from '../lib/env';
import { connectStdb } from '../lib/stdb';

const ds = loadDataset();
const bank = await openBank();
const { conn } = await connectStdb();

await new Promise<void>((resolve) =>
  conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([
    tables.platform, tables.clock, tables.syncSource, tables.rawRecord, tables.client, tables.payerIdentity,
    tables.contract, tables.contractClause, tables.capability, tables.accessLever, tables.invoice, tables.dispute,
    tables.cashMovement, tables.custodyHolding, tables.assetPrice, tables.owedToClient, tables.position, tables.loan,
    tables.precedent, tables.metricSnapshot,
  ]),
);

const db = conn.db;
const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  if (!ok) failures.push(msg);
};
const simDate = db.clock.id.find(1)?.simDate ?? '';

// 1. Row counts match what the sources hold.
const expectCount = (name: string, actual: number, expected: number) => {
  check(actual === expected, `${name}: ${actual} rows, expected ${expected}`);
  console.log(`  ${actual === expected ? 'ok ' : 'BAD'} ${name.padEnd(18)} ${actual}`);
};
const plan = buildSeedPlan(ds);
const visibleBank = plan.transactions.filter(
  (t) => t.side === 'platform' && t.transaction_date <= simDate,
);
const visibleChain = ds.onchain.filter((p) => p.valueDate <= simDate);
console.log(`Sim date ${simDate} · bank ${bank.mode} run ${bank.map.run}\n\nCounts:`);
expectCount('client', [...db.client.iter()].length, ds.clients.length);
expectCount('contract', [...db.contract.iter()].length, ds.clients.length);
expectCount('contract_clause', [...db.contractClause.iter()].length, ds.clients.flatMap(clausesFor).length);
// Identities: every one from the CRM must be present; accounts confirmed by an accountant may be added on top.
const sourceIdentities = ds.clients.length * 2 + ds.onchain.filter((p) => p.clientId).length + ds.affiliates.length * 2;
const identityRows = [...db.payerIdentity.iter()];
const approvedAdds = identityRows.filter((p) => p.id.includes(':acct:')).length;
expectCount('payer_identity', identityRows.length - approvedAdds, sourceIdentities);
if (approvedAdds) console.log(`      + ${approvedAdds} confirmed by an accountant`);
expectCount('invoice', [...db.invoice.iter()].length, ds.invoices.length);
expectCount('dispute', [...db.dispute.iter()].length, disputes(ds).length);
expectCount('capability', [...db.capability.iter()].length, capabilities().length);
expectCount('access_lever', [...db.accessLever.iter()].length, ds.clients.flatMap((c) => leversFor(c)).length);
expectCount('custody_holding', [...db.custodyHolding.iter()].length, ds.clients.flatMap(holdingsFor).length);
expectCount('asset_price', [...db.assetPrice.iter()].length, 3);
expectCount('owed_to_client', [...db.owedToClient.iter()].length, owedToClient(ds).length);
expectCount('position', [...db.position.iter()].length, ds.clients.flatMap(positionsFor).length);
expectCount('loan', [...db.loan.iter()].length, ds.loans.length);
expectCount('cash_movement', [...db.cashMovement.iter()].length, visibleBank.length + visibleChain.length + ds.history.cash.length);
expectCount('precedent', [...db.precedent.iter()].filter((p) => p.source === 'history').length, ds.history.precedents.length);
expectCount('metric_snapshot', [...db.metricSnapshot.iter()].length, ds.history.metrics.length);


// 2. Every movement the bank and chain show right now is in the database, field for field.
const jsonSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
const history = historyRecords(conn, ds, bank.map).filter((r) => r.table === 'cash_movement').map((r) => r.row as ReturnType<typeof chainRecords>[number]['row']);
const live = [...(await bankRecords(conn, bank, simDate)), ...chainRecords(conn, ds, simDate), ...history.map((row) => ({ row }))];
for (const { row: expected } of live) {
  const actual = db.cashMovement.id.find(expected.id);
  check(!!actual, `cash ${expected.bankRef} missing`);
  if (!actual) continue;
  for (const [field, value] of Object.entries(expected)) {
    if (field === 'matchStatus') continue; // owned by payment checking
    const a = JSON.stringify((actual as Record<string, unknown>)[field], jsonSafe);
    const e = JSON.stringify(value, jsonSafe);
    check(a === e, `cash ${expected.bankRef}: ${field} is ${a}, source says ${e}`);
  }
}
const liveIds = new Set(live.map((r) => r.row.id));
for (const m of db.cashMovement.iter()) check(liveIds.has(m.id), `cash ${m.bankRef} is in the database but not in the source`);
const hidden = plan.transactions.filter((t) => t.side === 'platform' && t.transaction_date > simDate);
const visibleRefs = new Set([...db.cashMovement.iter()].map((m) => m.bankRef));
for (const t of hidden) check(!visibleRefs.has(t.movementId), `cash ${t.movementId} is dated after the sim date but visible`);

// 3. No empty required fields.
const allowEmpty: Record<string, string[]> = {
  cash_movement: ['origName', 'origAccount', 'reverses'],
  invoice: ['paidOn'],
};
const tableRows: Record<string, Iterable<object>> = {
  client: db.client.iter(), payer_identity: db.payerIdentity.iter(), contract: db.contract.iter(),
  contract_clause: db.contractClause.iter(), capability: db.capability.iter(), access_lever: db.accessLever.iter(),
  invoice: db.invoice.iter(), dispute: db.dispute.iter(), cash_movement: db.cashMovement.iter(),
  custody_holding: db.custodyHolding.iter(), owed_to_client: db.owedToClient.iter(), position: db.position.iter(),
  loan: db.loan.iter(),
};
for (const [table, rows] of Object.entries(tableRows)) {
  for (const row of rows) {
    for (const [field, value] of Object.entries(row)) {
      if (allowEmpty[table]?.includes(field) || field === 'renewalOn' || field === 'hedgeGroup' || field === 'workItemId') continue;
      check(value !== '' && value !== null && value !== undefined, `${table} ${(row as { id?: string }).id ?? ''}: empty ${field}`);
    }
  }
}
// Only bank fees may lack a counterparty account; only chain may lack a name.
for (const m of db.cashMovement.iter()) {
  if (!m.origAccount) check(m.rail === 'BOOK', `cash ${m.bankRef}: no account on a ${m.rail} movement`);
  if (!m.origName) check(m.source === 'chain', `cash ${m.bankRef}: no counterparty name`);
}

// 4. Every client reference points at a real client.
const clientIds = new Set([...db.client.iter()].map((c) => c.id));
const fk: [string, Iterable<{ clientId: string }>][] = [
  ['payer_identity', db.payerIdentity.iter()], ['contract', db.contract.iter()], ['contract_clause', db.contractClause.iter()],
  ['access_lever', db.accessLever.iter()], ['invoice', db.invoice.iter()], ['dispute', db.dispute.iter()],
  ['custody_holding', db.custodyHolding.iter()], ['owed_to_client', db.owedToClient.iter()], ['position', db.position.iter()],
  ['loan', db.loan.iter()],
];
for (const [table, rows] of fk) for (const r of rows) check(clientIds.has(r.clientId), `${table}: unknown client ${r.clientId}`);
const invoiceIds = new Set([...db.invoice.iter()].map((i) => i.id));
for (const d of db.dispute.iter()) check(invoiceIds.has(d.invoiceId), `dispute ${d.id}: unknown invoice ${d.invoiceId}`);

// 5. Lineage: every cash movement has its raw record.
const rawIds = new Set([...db.rawRecord.iter()].map((r) => r.id));
for (const m of db.cashMovement.iter()) check(rawIds.has(m.rawId), `cash ${m.bankRef}: raw record ${m.rawId} missing`);

// 6. Every incoming payer resolves to a client, except the two planted unknowns.
const identities = new Map([...db.payerIdentity.iter()].filter((p) => p.kind === 'bank_account' || p.kind === 'wallet').map((p) => [p.value, p.clientId]));
const unresolved = [...db.cashMovement.iter()]
  .filter((m) => m.direction === 'in' && !identities.has(m.origAccount))
  .map((m) => m.bankRef)
  .sort();
const harbor = ds.movements.find((m) => m.caseId === 'new-bank-account')?.id;
const unknownWallet = ds.onchain.find((p) => p.caseId === 'unknown-wallet');
const expectedUnresolved = [harbor, unknownWallet && unknownWallet.valueDate <= simDate ? `TX-${unknownWallet.txHash.slice(2, 10)}` : undefined]
  .filter((x): x is string => !!x)
  .sort();
check(JSON.stringify(unresolved) === JSON.stringify(expectedUnresolved),
  `unresolved payers ${unresolved.join(', ') || 'none'}; expected ${expectedUnresolved.join(', ')}`);
console.log(`\nPayers not in the CRM (planted): ${unresolved.join(', ') || 'none'}`);

// 7. History patterns are detectable from the database alone (what the exploit agent will query).
console.log('\nHistory patterns:');
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const paidHistory = (clientId: string) =>
  [...db.invoice.iter()].filter((i) => i.clientId === clientId && i.issuedOn < '2026-01-01' && i.paidOn);
const pattern = (ok: boolean, label: string) => {
  check(ok, `pattern: ${label}`);
  console.log(`  ${ok ? 'ok ' : 'BAD'} ${label}`);
};
const juniper = paidHistory('ORG-90677').map((i) => days(i.dueOn, i.paidOn!));
pattern(juniper.length >= 20 && juniper.every((d) => d === 20), `Juniper pays on day 20, one day before the day-21 restriction (${juniper.length} invoices)`);
const kestrel = paidHistory('ORG-90412').filter((i) => ['2025-10', '2025-11', '2025-12'].includes(i.period));
pattern(kestrel.length > 0 && kestrel.every((i) => days(i.dueOn, i.paidOn!) > 0 && days(i.dueOn, i.paidOn!) <= 30),
  'Kestrel paid late in each of the last 3 months, always within 30 days');
const halcyonDates = new Set(paidHistory('ORG-90101').map((i) => i.paidOn!.slice(5)));
pattern([...halcyonDates].every((d) => ['03-31', '06-30', '09-30', '12-31', '01-31'].includes(d)), 'Halcyon pays only at quarter end');
const monarch = paidHistory('ORG-90758');
const lateBy = (product: string) => monarch.filter((i) => i.product === product).map((i) => days(i.dueOn, i.paidOn!));
pattern(lateBy('API').every((d) => d <= 2) && lateBy('CUSTODY').every((d) => d >= 25), 'Monarch pays API (restricted) fast, custody late');
const wrenCash = [...db.cashMovement.iter()].filter((m) => m.isHistory && m.origName.startsWith('Wrenfield'));
const perInvoice = new Map<string, number>();
for (const m of wrenCash) for (const r of m.refs) perInvoice.set(r, (perInvoice.get(r) ?? 0) + 1);
pattern(perInvoice.size > 0 && [...perInvoice.values()].every((n) => n === 2), 'Wrenfield pays every invoice in two partial payments');
const overrides = [...db.precedent.iter()].filter((p) => p.overrideReason);
pattern(overrides.length === 3, `${overrides.length} past overrides of pol-003 available for drafting (the live Kestrel override makes 4)`);

// 8. Every source reported a clean pass, and the platform row follows configuration.
for (const s of db.syncSource.iter()) check(s.status === 'synced', `source ${s.source}: ${s.status} ${s.error ?? ''}`);
check([...db.syncSource.iter()].length === 9, `expected 9 sync sources, found ${[...db.syncSource.iter()].length}`);
check(db.platform.id.find(1)?.name === env.PLATFORM_NAME, 'platform name does not match PLATFORM_NAME');

conn.disconnect();
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):\n- ${failures.slice(0, 40).join('\n- ')}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);
