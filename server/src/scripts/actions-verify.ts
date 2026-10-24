/**
 * Exercises every agent action end to end on the shared database: proposal
 * checks, auto-approval by policy, controller approval, the scheduled clock and
 * cure periods, gateway execution, Nessie (wire, bills, balances), books and tie-out.
 * Usage: pnpm actions:verify  (after pnpm demo:reset; run demo:reset again afterwards)
 */
import { execFileSync } from 'node:child_process';
import { loadDataset } from '../dataset';
import { Gateway } from '../gateway/executor';
import { openBank } from '../integrations/nessie/bank';
import { env } from '../lib/env';
import { connectStdb } from '../lib/stdb';
import { tables, type DbConnection } from '../module_bindings';
import { openPlatform } from '../platform/bootstrap';
import { LocalPlatform } from '../platform/client';
import { Sync } from '../sync';

const KESTREL = 'ORG-90412'; // no debit clause, set-off right, hedged book
const BLUEFIN = 'ORG-90233'; // debit clause signed, plenty of USD in custody

if (!env.STDB_GATEWAY_TOKEN || !env.STDB_DEMO_TOKEN || !process.env.STDB_AGENT_TOKEN) throw new Error('needs gateway, demo and agent tokens in .env');
const identityOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).hex_identity as string;

const ds = loadDataset();
const bank = await openBank();
const { conn: syncConn } = await connectStdb(env.STDB_TOKEN);
const platform = await openPlatform(syncConn, ds);
const sync = new Sync(syncConn, bank, ds, platform);
await sync.ready();
const { conn: gwConn } = await connectStdb(env.STDB_GATEWAY_TOKEN);
const gateway = new Gateway(gwConn, new LocalPlatform(platform), bank, ds, (accounts) => sync.cash(accounts), () => {});
await gateway.ready();
const { conn: agent } = await connectStdb(process.env.STDB_AGENT_TOKEN);
const { conn: demo } = await connectStdb(env.STDB_DEMO_TOKEN);
// A throwaway controller identity, registered by the publisher (ADMIN).
const { conn: controller, token: controllerToken } = await connectStdb('');
execFileSync('spacetime', ['call', '-s', 'maincloud', env.STDB_DATABASE, 'assign_role', JSON.stringify(identityOf(controllerToken)), '"verify-controller"', '"CONTROLLER"', 'null'], { stdio: ['ignore', 'ignore', 'inherit'] });

const subscribe = (conn: DbConnection) => new Promise<void>((resolve) => conn.subscriptionBuilder().onApplied(() => resolve()).subscribe([
  tables.workItem, tables.invoice, tables.paymentApplication, tables.ledgerEntry, tables.custodyHolding, tables.hold,
  tables.accessLever, tables.accessRequest, tables.cashMovement, tables.notice, tables.tieOutRun, tables.auditEvent,
  tables.clock, tables.deadline, tables.bankAccount,
]));
await subscribe(controller);
const db = controller.db;

let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? 'ok ' : 'BAD'} ${label}${!ok && detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const refused = async (call: Promise<unknown>, expect: RegExp) => {
  try {
    await call;
    return 'accepted';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return expect.test(msg) ? true : msg;
  }
};
const settle = async () => {
  await wait(400);
  await gateway.drain();
  await gateway.settled();
  await wait(600);
};
const latestItem = (clientId: string, kind: string) =>
  [...db.workItem.iter()].filter((w) => w.clientId === clientId && w.kind === kind).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
const usd = (clientId: string) => db.custodyHolding.id.find(`${clientId}:USD`)?.valueCents ?? 0n;
const reason = 'verify';

console.log('Custody debit');
let r = await refused(agent.reducers.proposeCustodyDebit({ clientId: KESTREL, invoiceIds: [], reasoning: reason, policyRef: 'pol-005', confidence: 0.9 }), /6\.3/);
check(r === true, 'Kestrel refused: no debit clause (§6.3)', String(r));

const usdBefore = usd(BLUEFIN);
await agent.reducers.proposeCustodyDebit({ clientId: BLUEFIN, invoiceIds: ['INV-1762'], reasoning: reason, policyRef: 'pol-005', confidence: 0.9 });
await settle();
let item = latestItem(BLUEFIN, 'CUSTODY_DEBIT');
check(!!item?.autoApplied && item.state === 'POSTED', 'Bluefin $22,400 auto-applied under pol-005 and POSTED', `${item?.state} auto=${item?.autoApplied}`);
check(db.invoice.id.find('INV-1762')?.status === 'paid', 'INV-1762 paid');
check([...db.paymentApplication.iter()].some((a) => a.invoiceId === 'INV-1762' && a.method === 'custody_debit' && a.posted), 'Application confirmed by billing');
check(usdBefore - usd(BLUEFIN) === 2_240_000n, 'Custody USD down $22,400', `${usdBefore - usd(BLUEFIN)}`);
check(!!db.ledgerEntry.id.find(`JE-CD-${item?.id}:1`), 'Journal JE-CD booked (Dr 2100 / Cr 1200)');
const billId = bank.map.bills['INV-1762'];
const bill = billId ? (await bank.api.listBills(bank.map.accounts[BLUEFIN]!.id)).find((b) => b._id === billId) : undefined;
check(bill?.status === 'completed', 'Nessie bill for INV-1762 completed', bill?.status);

await agent.reducers.proposeCustodyDebit({ clientId: BLUEFIN, invoiceIds: ['INV-1763'], reasoning: reason, policyRef: 'pol-005', confidence: 0.9 });
await wait(500);
item = latestItem(BLUEFIN, 'CUSTODY_DEBIT');
check(item?.state === 'PROPOSED', '$64,000 is over the auto-apply limit: waits for a controller', item?.state);
await agent.reducers.transitionWorkItem({ workItemId: item!.id, toState: 'APPROVED', note: '' });
await wait(400);
check(db.workItem.id.find(item!.id)?.state === 'PROPOSED', 'Agent cannot approve (denied and audited)');
await controller.reducers.transitionWorkItem({ workItemId: item!.id, toState: 'APPROVED', note: 'verify' });
await settle();
check(db.workItem.id.find(item!.id)?.state === 'POSTED', 'Controller approved; gateway POSTED it');

console.log('\nRestrictions');
r = await refused(agent.reducers.proposeRestriction({ clientId: KESTREL, lever: 'trading', step: 'CLOSE_ONLY', reasoning: reason, policyRef: 'pol-008', confidence: 0.9 }), /hedged/);
check(r === true, 'Close-only on Kestrel refused (hedged book)', String(r));
r = await refused(agent.reducers.proposeRestriction({ clientId: KESTREL, lever: 'financing', step: 'NO_NEW_BORROWING', reasoning: reason, policyRef: 'pol-006', confidence: 0.9 }), /contract/);
check(r === true, 'Financing refused: not in Kestrel\'s contract', String(r));
const cure = () => [...db.deadline.iter()].find((d) => d.clientId === KESTREL && d.kind === 'cure_period');
check(cure()?.status === 'open' && cure()?.dueOn === '2026-03-06', 'Kestrel notified Feb 19: cure period (§9.1) runs to Mar 6', `${cure()?.status} ${cure()?.dueOn}`);
r = await refused(agent.reducers.proposeRestriction({ clientId: KESTREL, lever: 'withdrawals', step: 'HOLD_AMOUNT_OWED', reasoning: reason, policyRef: 'pol-006', confidence: 0.9 }), /9\.1/);
check(r === true, 'Hold refused while the cure period runs', String(r));

console.log('\nTime (scheduled reducer)');
await agent.reducers.setDeadline({ clientId: KESTREL, kind: 'promise_to_pay', dueOn: '2026-03-05', note: 'CFO promised a wire by Thursday', workItemId: undefined });
await demo.reducers.setClockSpeed({ secondsPerDay: 1, runUntil: '2026-03-06' });
await wait(5_000);
const clock = db.clock.id.find(1);
check(clock?.simDate === '2026-03-06' && clock.secondsPerDay === 0, 'Clock ran on its own to Mar 6 and paused', `${clock?.simDate} ${clock?.secondsPerDay}`);
check(cure()?.status === 'expired', 'Cure period expired unpaid', cure()?.status);
const promise = [...db.deadline.iter()].find((d) => d.clientId === KESTREL && d.kind === 'promise_to_pay');
check(promise?.status === 'broken', 'Promise to pay marked broken', promise?.status);
await settle();

await agent.reducers.proposeRestriction({ clientId: KESTREL, lever: 'withdrawals', step: 'HOLD_AMOUNT_OWED', reasoning: reason, policyRef: 'pol-006', confidence: 0.9 });
await wait(500);
item = latestItem(KESTREL, 'RESTRICTION');
check(item?.state === 'PROPOSED' && !item.autoApplied, 'Hold proposed; restrictions never auto-apply');
check(item?.amountCents === 14_820_000n, 'Holds exactly the undisputed overdue $148,200', `${item?.amountCents}`);
await controller.reducers.transitionWorkItem({ workItemId: item!.id, toState: 'APPROVED', note: 'verify' });
await settle();
const hold = [...db.hold.iter()].find((h) => h.clientId === KESTREL && h.status === 'active');
check(hold?.amountCents === 14_820_000n, 'Hold active');
check(db.accessLever.id.find(`${KESTREL}:withdrawals`)?.state === 'limited', 'Withdrawals limited at the platform');
check(db.workItem.id.find(item!.id)?.state === 'POSTED', 'Restriction POSTED');

await controller.reducers.proposeRestriction({ clientId: KESTREL, lever: 'api', step: 'RATE_LIMIT', reasoning: reason, policyRef: 'pol-006', confidence: 0.9 });
await wait(500);
item = latestItem(KESTREL, 'RESTRICTION');
await controller.reducers.transitionWorkItem({ workItemId: item!.id, toState: 'APPROVED', note: '' });
await wait(400);
check(db.workItem.id.find(item!.id)?.state === 'PROPOSED', 'No self-approval');
const denial = [...db.auditEvent.iter()].find((a) => a.workItemId === item!.id && !a.allowed);
check(denial?.detail === 'no self-approval', 'Denial written to the audit log');

console.log('\nCustody withdrawal');
const kestrelUsd = usd(KESTREL);
const bankBal = (key: string) => db.bankAccount.id.find(key)?.postedCents ?? 0n;
const kestrelBank = bankBal(KESTREL);
const disbursements = bankBal('disbursements');
await demo.reducers.requestCustodyWithdrawal({ clientId: KESTREL, amountCents: 5_000_000n });
await settle();
const request = [...db.accessRequest.iter()].filter((a) => a.clientId === KESTREL).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
check(request?.allowedCents === 2_600_000n && request.heldCents === 2_400_000n, 'Asked $50,000: $26,000 released, $24,000 held', `${request?.allowedCents}/${request?.heldCents}`);
check(kestrelUsd - usd(KESTREL) === 2_600_000n, 'Custody USD down $26,000');
const ref = `CW-${String(request?.id).padStart(4, '0')}`;
const wire = [...db.cashMovement.iter()].find((m) => m.refs.includes(ref));
check(wire?.direction === 'out' && wire.amountCents === 2_600_000n, `Nessie wire ${ref} came back through the bank feed`);
check(wire?.matchStatus === 'matched', 'Recognized as the approved withdrawal', wire?.matchStatus);
check(!!db.ledgerEntry.id.find(`JE-R-${wire?.bankRef}:1`), 'Booked Dr 2100 client funds / Cr 1011 disbursements');
check(bankBal(KESTREL) - kestrelBank === 2_600_000n, "Kestrel's bank balance (Nessie statement) up $26,000", `${bankBal(KESTREL) - kestrelBank}`);
check(disbursements - bankBal('disbursements') === 2_600_000n, 'Disbursements balance down $26,000');

console.log('\nNotices');
await agent.reducers.proposeNotice({ clientId: KESTREL, channel: 'email', body: 'Your February invoices are overdue; $148,200 of withdrawals is held under §7.2.', reasoning: reason, policyRef: 'pol-007', confidence: 0.9 });
await settle();
item = latestItem(KESTREL, 'REMINDER');
check(item?.state === 'POSTED', 'Notice auto-sent under pol-007', item?.state);
check([...db.notice.iter()].some((n) => n.workItemId === item?.id && n.status === 'sent'), 'Notice marked sent');

console.log('\nRestore');
await agent.reducers.proposeRestore({ clientId: KESTREL, lever: 'withdrawals', reasoning: reason, policyRef: 'pol-011', confidence: 0.9 });
await settle();
item = latestItem(KESTREL, 'RESTORE');
check(item?.state === 'POSTED', 'Restore auto-applied under pol-011', item?.state);
check(![...db.hold.iter()].some((h) => h.clientId === KESTREL && h.status === 'active'), 'Hold released');
check(db.accessLever.id.find(`${KESTREL}:withdrawals`)?.state === 'active', 'Withdrawals active again');

console.log('\nBooks');
await gwConn.reducers.tieOut({ trigger: 'actions verify' });
await wait(800);
const run = [...db.tieOutRun.iter()].sort((a, b) => (a.id < b.id ? 1 : -1))[0];
check(run?.unexplainedCents === 0n, 'Tie-out: nothing unexplained after every action', `${run?.status} ${run?.unexplainedCents}`);

for (const c of [syncConn, gwConn, agent, demo, controller]) c.disconnect();
console.log(failed ? `\nFAILED: ${failed} checks` : '\nAll checks passed. (Run pnpm demo:reset to go back to the baseline.)');
process.exit(failed ? 1 : 0);
