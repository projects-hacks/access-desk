import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDataset } from '../dataset';
import { achReturn } from '../integrations/bank-text/format';
import { extractRefs, parseBankText } from '../integrations/bank-text/parse';
import { CallBudget } from './budget';
import { clockDecision } from './clock';
import { isWorldRef, nextRef } from './refs';
import { remittanceText } from './remittance';

test('references continue above everything used, stay out of the dataset ranges, and are recognizable by payment checking', () => {
  assert.equal(nextRef('wire', ['WI-5401', 'WI-5531', 'JD-0003', 'AC-7102']), 'WI-6000');
  assert.equal(nextRef('wire', ['WI-6000', 'WI-6041', 'WI-6012']), 'WI-6042');
  assert.equal(nextRef('ach', ['AC-7102', 'AC-8003']), 'AC-8004');
  assert.deepEqual(extractRefs('REFUND DUPLICATE PMT WI-6042').refs, ['WI-6042']);
  assert.ok(['WI-6000', 'AC-9999', 'WE-00007'].every(isWorldRef));
  assert.ok(['WI-5401', 'AC-7102', 'JD-0001', 'CW-0001', 'TX-1234'].every((r) => !isWorldRef(r)));
});

test('when a range runs out, references continue as WE-nnnnn and stay unique', () => {
  const full = nextRef('wire', ['WI-9999']);
  assert.equal(full, 'WE-00001');
  assert.equal(nextRef('wire', ['WI-9999', 'WE-00001']), 'WE-00002');
  assert.equal(nextRef('ach', ['AC-9999', 'WE-00002']), 'WE-00003');
});

test('the bank-write cap is a sliding minute', () => {
  let t = 0;
  const budget = new CallBudget(4, () => t);
  assert.ok(budget.take(2) && budget.take(2));
  assert.equal(budget.take(1), false);
  t = 30_000;
  assert.equal(budget.take(1), false);
  t = 60_001;
  assert.ok(budget.take(1));
  assert.equal(budget.used(), 1);
});

test('the clock is kept at pace, but a person is never fought', () => {
  const want = { secondsPerDay: 240, graceMs: 300_000 };
  const now = 10_000_000;
  const clock = (secondsPerDay: number, ageMs: number, runUntil?: string) => ({ secondsPerDay, runUntil, updatedAtMs: now - ageMs });
  assert.equal(clockDecision(clock(240, 5_000), want, now), 'ok');
  assert.equal(clockDecision(clock(30, 5_000), want, now), 'foreign');
  assert.equal(clockDecision(clock(240, 5_000, '2026-04-01'), want, now), 'foreign');
  assert.equal(clockDecision(clock(0, 60_000), want, now), 'paused');
  assert.equal(clockDecision(clock(0, 300_000), want, now), 'resume');
  assert.equal(clockDecision(clock(0, 999_999_999), { secondsPerDay: 0, graceMs: 1 }, now), 'ok');
});

test('remittance text round-trips through the bank-text parser in each payer\'s habit', () => {
  const ids = ['INV-1201', 'INV-1202', 'INV-1203'];
  const base = { invoiceIds: ids, payer: 'client' as const, typo: false };
  const client = { id: 'ORG-90229' };
  assert.deepEqual(extractRefs(remittanceText({ ...base, reference: 'invoices' }, client, 'US', '2026-03')).refs, ids);
  const swift = remittanceText({ ...base, reference: 'invoices' }, client, 'CZ', '2026-03');
  assert.ok(swift.startsWith('/INV/') && swift.endsWith('/RFB/MAR26'));
  assert.deepEqual(extractRefs(swift).refs, ids);
  assert.deepEqual(extractRefs(remittanceText({ ...base, reference: 'client' }, client, 'US', '2026-03')).refs, ['ORG-90229']);
  assert.deepEqual(extractRefs(remittanceText({ ...base, payer: 'affiliate', reference: 'client' }, client, 'US', '2026-03')).refs, ['ORG-90229']);
  assert.equal(remittanceText({ ...base, reference: 'none' }, client, 'US', '2026-03'), '');
  // A keying slip is repaired by the parser and flagged.
  const typo = remittanceText({ ...base, typo: true, reference: 'invoices' }, client, 'US', '2026-03');
  assert.notEqual(typo, remittanceText({ ...base, reference: 'invoices' }, client, 'US', '2026-03'));
  assert.deepEqual(extractRefs(typo).refs, ids);
  assert.equal(extractRefs(typo).repaired, true);
});

test('an ACH return names the trace it reverses', () => {
  const ds = loadDataset();
  const c = ds.clients.find((x) => x.id === 'ORG-90689')!;
  const text = achReturn({ trace: 'AC-8002', originalTrace: 'AC-8001', code: 'R01', reason: 'Insufficient funds', company: c.legalName, account: '4000' });
  const p = parseBankText(text);
  assert.deepEqual([p.category, p.bankRef, p.reverses], ['ach_return', 'AC-8002', 'AC-8001']);
});
