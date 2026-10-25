import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDataset } from '../dataset';
import { daysBetween } from '../dataset/dates';
import { simulateBook } from './harness';

const ds = loadDataset();
const DAYS = 120;

/** The book over four months at the default cadence (six client events a sim day), no database. */
for (const seed of [1, 2, 3]) {
  test(`the book stays believable for ${DAYS} sim days (seed ${seed})`, () => {
    const r = simulateBook(ds, DAYS, seed);
    const issued = r.paid.filter((p) => p.issuedInSim);
    const late = issued.map((p) => daysBetween(p.dueOn, p.paidOn));
    const share = (f: (days: number) => boolean) => late.filter(f).length / late.length;

    // Billing ran each month: March, April, May and June closed (March 3 + 120 days = July 1).
    assert.ok(issued.length > 120, `${issued.length} new invoices paid`);
    assert.ok(share((d) => d <= 0) >= 0.55, `on time ${share((d) => d <= 0)}`);
    assert.ok(share((d) => d <= 7) >= 0.75, `within a week ${share((d) => d <= 7)}`);
    assert.ok(share((d) => d > 30) <= 0.1, `over a month late ${share((d) => d > 30)}`);

    // What is still overdue belongs to clients whose personality it is (or sits in a dispute).
    const stuck = r.open.filter((i) => !i.disputed && daysBetween(i.dueOn, r.date) > 45);
    for (const i of stuck) {
      const p = r.profiles.get(i.clientId)!;
      assert.ok(['delinquent', 'quarter_end', 'disputer', 'partial'].includes(p.personality), `${p.name} (${p.personality}) has ${i.id} ${daysBetween(i.dueOn, r.date)} days overdue`);
    }
    // Delinquent clients really do stay behind.
    assert.ok(r.open.some((i) => r.profiles.get(i.clientId)!.personality === 'delinquent' && i.dueOn < r.date));
  });
}

test('events are not flooded and not one-note', () => {
  const r = simulateBook(ds, 60, 4);
  assert.ok(r.maxPerClientDay <= 2, `a client had ${r.maxPerClientDay} events in a day`);
  const total = Object.values(r.kinds).reduce((a, b) => a + b, 0);
  assert.ok(total > 300 && total <= 6 * 60);
  const share = (k: string) => (r.kinds[k] ?? 0) / total;
  assert.ok(share('pay') > 0.3 && share('pay') < 0.7, `pay ${share('pay')}`);
  assert.ok(share('trade') > 0.1 && share('withdraw') > 0.03, `trade ${share('trade')} withdraw ${share('withdraw')}`);
  assert.ok(share('duplicate') < 0.05, `duplicate ${share('duplicate')}`);
});
