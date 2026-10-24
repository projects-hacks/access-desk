import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exactSubset, formatUsd, normalizeName, planMatch, type CandidateInvoice } from './match';

const inv = (id: string, dueOn: string, dollars: number, balanceDollars = dollars): CandidateInvoice => ({
  id, dueOn, amountCents: BigInt(dollars * 100), balanceCents: BigInt(balanceDollars * 100),
});
const c = (d: number) => BigInt(Math.round(d * 100));

test('referenced invoices, exact amount', () => {
  const r = planMatch(c(58000), [inv('A', '2026-02-26', 32400), inv('B', '2026-02-26', 25600)], ['A', 'B'], []);
  assert.equal(r.kind === 'plan' && r.plan.method, 'referenced');
});

test('short by $25 is written off as a bank fee', () => {
  const r = planMatch(c(57975), [inv('A', '2026-02-26', 32400), inv('B', '2026-02-26', 25600)], ['A', 'B'], []);
  assert.ok(r.kind === 'plan');
  assert.equal(r.plan.method, 'short_fee');
  assert.equal(r.plan.shortCents, 2500n);
  assert.equal(r.plan.allocations.reduce((s, a) => s + a.amountCents, 0n), c(57975));
});

test('overpayment keeps the excess as credit', () => {
  const r = planMatch(c(111020), [inv('A', '2026-02-21', 12500), inv('B', '2026-02-21', 97520)], ['A', 'B'], []);
  assert.ok(r.kind === 'plan');
  assert.equal(r.plan.method, 'overpaid');
  assert.equal(r.plan.excessCents, c(1000));
});

test('wrong references fall back to the exact open set (oldest first)', () => {
  const jan = [inv('J1', '2026-02-21', 17800), inv('J2', '2026-02-21', 45000)];
  const feb = [inv('F1', '2026-03-21', 18100), inv('F2', '2026-03-21', 47900)];
  const r = planMatch(c(62800), [...jan, ...feb], ['F1', 'F2'], []);
  assert.ok(r.kind === 'plan');
  assert.equal(r.plan.method, 'split');
  assert.deepEqual(r.plan.allocations.map((a) => a.invoiceId).sort(), ['J1', 'J2']);
  assert.equal(r.plan.usedReferences, false);
});

test('lump sum with no invoice references finds the combination', () => {
  const open = [
    inv('D1', '2026-01-21', 15000), inv('D2', '2026-01-21', 50000), inv('D3', '2026-01-21', 11000),
    inv('J1', '2026-02-21', 16000), inv('J2', '2026-02-21', 58000), inv('J3', '2026-02-21', 11290),
    inv('F1', '2026-03-21', 15500),
  ];
  const r = planMatch(c(161290), open, [], []);
  assert.ok(r.kind === 'plan');
  assert.equal(r.plan.method, 'split');
  assert.equal(r.plan.allocations.length, 6);
});

test('single exact invoice without references', () => {
  const r = planMatch(c(18750), [inv('A', '2026-03-03', 18750), inv('B', '2026-03-31', 19000)], [], []);
  assert.equal(r.kind === 'plan' && r.plan.method, 'exact');
});

test('partial payment of a quoted invoice', () => {
  const r = planMatch(c(6450), [inv('A', '2026-02-11', 12900), inv('B', '2026-03-11', 12000)], ['A'], []);
  assert.ok(r.kind === 'plan');
  assert.equal(r.plan.method, 'partial');
  assert.deepEqual(r.plan.allocations, [{ invoiceId: 'A', amountCents: c(6450) }]);
});

test('second wire for already-paid invoices is a duplicate', () => {
  const r = planMatch(c(40520), [inv('F1', '2026-03-16', 9300)], ['A', 'B'], ['A', 'B']);
  assert.deepEqual(r, { kind: 'duplicate', invoiceIds: ['A', 'B'] });
});

test('exactSubset prefers the oldest debt', () => {
  const set = exactSubset(c(100), [inv('NEW', '2026-03-01', 100), inv('OLD', '2026-01-01', 100)]);
  assert.deepEqual(set?.map((i) => i.id), ['OLD']);
});

test('helpers', () => {
  assert.equal(normalizeName('Harbor & Pine Treasury'), normalizeName('Harbor and Pine Treasury Inc'));
  assert.equal(formatUsd(14_820_000n), '$148,200.00');
  assert.equal(formatUsd(-2500n), '-$25.00');
});
