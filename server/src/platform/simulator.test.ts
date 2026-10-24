import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDataset } from '../dataset';
import { PlatformError, PlatformSimulator } from './simulator';

const ds = loadDataset();
const kestrelJan = ds.invoices.filter((i) => i.clientId === 'ORG-90412' && i.period === '2026-01' && i.status === 'open');

test('applying a payment marks invoices paid and is idempotent by command id', () => {
  const sim = new PlatformSimulator(ds);
  const action = {
    type: 'APPLY_PAYMENT' as const, movementId: 'm1', on: '2026-03-10',
    applications: kestrelJan.map((i, n) => ({ applicationId: String(n), invoiceId: i.id, amountCents: i.amountCents })),
  };
  const first = sim.apply('cmd-1', action);
  const again = sim.apply('cmd-1', action);
  assert.deepEqual(first, again);
  assert.ok(kestrelJan.every((i) => sim.invoices.get(i.id)!.paidOn === '2026-03-10'));
  assert.throws(() => sim.apply('cmd-2', action), PlatformError); // paying twice would exceed the amount
});

test('reversal reopens the invoice', () => {
  const sim = new PlatformSimulator(ds);
  const inv = kestrelJan[0]!;
  const line = [{ applicationId: 'a', invoiceId: inv.id, amountCents: inv.amountCents }];
  sim.apply('c1', { type: 'APPLY_PAYMENT', movementId: 'm', on: '2026-03-10', applications: line });
  sim.apply('c2', { type: 'REVERSE_PAYMENT', movementId: 'm', on: '2026-03-11', applications: line });
  assert.equal(sim.invoices.get(inv.id)!.paidCents, 0);
  assert.equal(sim.invoices.get(inv.id)!.paidOn, undefined);
});

test('journals must balance and cannot overwrite billing or treasury entries', () => {
  const sim = new PlatformSimulator(ds);
  const lines = [{ account: '2300', debitCents: 100, creditCents: 0 }, { account: '1200', debitCents: 0, creditCents: 99 }];
  assert.throws(() => sim.apply('j1', { type: 'POST_JOURNAL', journal: { journalId: 'JE-X', postedOn: '2026-03-03', ref: 'r', memo: 'm', lines } }), PlatformError);
  const booked = [...sim.journals.values()][0]!;
  const ok = [{ account: '2300', debitCents: 1, creditCents: 0 }, { account: '1200', debitCents: 0, creditCents: 1 }];
  assert.throws(() => sim.apply('j2', { type: 'POST_JOURNAL', journal: { journalId: booked.journalId, postedOn: '2026-03-03', ref: 'r', memo: 'm', lines: ok } }), PlatformError);
});

test('holds limit withdrawals until released; unused levers are refused', () => {
  const sim = new PlatformSimulator(ds);
  sim.apply('h1', { type: 'PLACE_HOLD', clientId: 'ORG-90412', holdId: '1', amountCents: 14_820_000, clause: '7.2' });
  assert.equal(sim.levers.get('ORG-90412:withdrawals')!.state, 'limited');
  sim.apply('h2', { type: 'RELEASE_HOLD', clientId: 'ORG-90412', holdId: '1' });
  assert.equal(sim.levers.get('ORG-90412:withdrawals')!.state, 'active');
  assert.throws(() => sim.apply('h3', { type: 'SET_LEVER', clientId: 'ORG-90412', lever: 'financing', state: 'off', detail: 'x' }), PlatformError);
});

test('custody debit must match what is owed and fit the cash balance', () => {
  const sim = new PlatformSimulator(ds);
  const bluefin = ds.invoices.filter((i) => i.clientId === 'ORG-90233' && i.period === '2026-01');
  const owed = bluefin.reduce((s, i) => s + i.amountCents, 0);
  const before = sim.holdings.get('ORG-90233:USD')!.valueCents;
  sim.apply('d1', { type: 'CUSTODY_DEBIT', clientId: 'ORG-90233', amountCents: owed, on: '2026-03-03', invoiceIds: bluefin.map((i) => i.id), applications: [] });
  assert.equal(sim.holdings.get('ORG-90233:USD')!.valueCents, before - owed);
  assert.ok(bluefin.every((i) => sim.invoices.get(i.id)!.status === 'paid'));
  assert.throws(() => sim.apply('d2', { type: 'CUSTODY_DEBIT', clientId: 'ORG-90233', amountCents: 1, on: '2026-03-03', invoiceIds: bluefin.map((i) => i.id), applications: [] }), PlatformError);
});

test('custody withdrawal never touches held cash', () => {
  const sim = new PlatformSimulator(ds);
  const usd = sim.holdings.get('ORG-90412:USD')!;
  const before = usd.valueCents;
  sim.apply('h1', { type: 'PLACE_HOLD', clientId: 'ORG-90412', holdId: '1', amountCents: before - 1_000_00, clause: '7.2' });
  assert.throws(() => sim.apply('w1', { type: 'CUSTODY_WITHDRAWAL', clientId: 'ORG-90412', withdrawalId: '1', amountCents: 1_000_01, on: '2026-03-03' }), PlatformError);
  sim.apply('w2', { type: 'CUSTODY_WITHDRAWAL', clientId: 'ORG-90412', withdrawalId: '2', amountCents: 1_000_00, on: '2026-03-03' });
  assert.equal(sim.holdings.get('ORG-90412:USD')!.valueCents, before - 1_000_00);
});
