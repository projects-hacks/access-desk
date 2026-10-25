import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDataset } from '../dataset';
import { monthlyAmount } from '../dataset/build';
import { addDays } from '../dataset/dates';
import { isBalanced } from '../dataset/gl';
import { PlatformSimulator } from '../platform/simulator';
import { invoiceKey, invoicesToIssue, periodsDue } from './billing';

const ds = loadDataset();
const none = { ids: ds.invoices.map((i) => i.id), keys: new Set(ds.invoices.map((i) => invoiceKey(i.clientId, i.product, i.period))) };

test('nothing is billed until the month closes', () => {
  assert.deepEqual(periodsDue(ds, '2026-03-03'), []);
  assert.deepEqual(periodsDue(ds, '2026-03-31'), []);
  assert.equal(invoicesToIssue(ds, '2026-03-31', none).length, 0);
});

test('on the 1st, each client is billed March for every product it has, with its terms and monthly fee', () => {
  assert.deepEqual(periodsDue(ds, '2026-04-01'), ['2026-03']);
  const issued = invoicesToIssue(ds, '2026-04-01', none);
  assert.equal(issued.length, ds.clients.reduce((n, c) => n + c.products.length, 0));
  const taken = new Set(ds.invoices.map((i) => i.id));
  for (const i of issued) {
    assert.ok(!taken.has(i.id), `${i.id} collides`);
    taken.add(i.id);
    const c = ds.clients.find((x) => x.id === i.clientId)!;
    assert.equal(i.issuedOn, '2026-04-01');
    assert.equal(i.dueOn, addDays('2026-04-01', c.termsDays));
    assert.equal(i.amountCents, monthlyAmount(c, i.product, '2026-03'));
    assert.ok(c.products.includes(i.product) && i.status === 'open' && i.paidCents === 0);
  }
  const numbers = issued.map((i) => Number(i.id.slice(4)));
  assert.equal(numbers[0], Math.max(...ds.invoices.map((i) => Number(i.id.slice(4)))) + 1);
  assert.ok(numbers.every((n, k) => k === 0 || n === numbers[k - 1]! + 1));
});

test('a restart mid-month bills only what is missing, and a run twice bills nothing', () => {
  const issued = invoicesToIssue(ds, '2026-04-01', none);
  const partial = { ids: [...none.ids, ...issued.slice(0, 10).map((i) => i.id)], keys: new Set([...none.keys, ...issued.slice(0, 10).map((i) => invoiceKey(i.clientId, i.product, i.period))]) };
  const rest = invoicesToIssue(ds, '2026-04-15', partial);
  assert.equal(rest.length, issued.length - 10);
  assert.equal(rest[0]!.id, `INV-${Number(issued[9]!.id.slice(4)) + 1}`);
  const all = { ids: [...none.ids, ...issued.map((i) => i.id)], keys: new Set([...none.keys, ...issued.map((i) => invoiceKey(i.clientId, i.product, i.period))]) };
  assert.equal(invoicesToIssue(ds, '2026-04-20', all).length, 0);
});

test('a clock moved far ahead catches up month by month, in order', () => {
  const issued = invoicesToIssue(ds, '2026-06-10', none);
  assert.deepEqual([...new Set(issued.map((i) => i.period))], ['2026-03', '2026-04', '2026-05']);
  assert.ok(issued.every((i, k) => k === 0 || issued[k - 1]!.issuedOn <= i.issuedOn));
});

test('the platform books what it issues (receivables against revenue) exactly once', () => {
  const sim = new PlatformSimulator(ds);
  const issued = invoicesToIssue(ds, '2026-04-01', none);
  assert.equal(sim.issue(issued).length, issued.length);
  assert.equal(sim.issue(issued).length, 0);
  const journal = sim.journals.get(`JE-INV-${issued[0]!.id}`)!;
  assert.ok(isBalanced(journal) && journal.source === 'billing' && journal.lines[0]!.account === '1200');
  assert.equal(sim.invoices.get(issued[0]!.id)!.amountCents, issued[0]!.amountCents);
  sim.reset();
  assert.equal(sim.invoices.has(issued[0]!.id), false);
});
