import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDataset } from '.';
import { ACCOUNTS, baselineJournals, isBalanced, trialBalance } from './gl';

const ds = loadDataset();
const journals = baselineJournals(ds);
const tb = trialBalance(journals);

test('every baseline journal balances and the trial balance is zero', () => {
  assert.ok(journals.every(isBalanced));
  assert.equal([...tb.values()].reduce((a, b) => a + b, 0), 0);
  assert.equal(new Set(journals.map((j) => j.journalId)).size, journals.length);
});

test('receivables in the GL equal what billing says is owed', () => {
  const owed = ds.invoices.filter((i) => i.issuedOn <= ds.simDate).reduce((s, i) => s + i.amountCents - i.paidCents, 0);
  assert.equal(tb.get(ACCOUNTS.RECEIVABLES), owed);
});

test('unapplied cash is exactly the cash billing never applied', () => {
  const saltmarsh = ds.movements.find((m) => m.caseId === 'paid-not-applied')!.amountCents;
  const ostravaSecond = ds.movements.filter((m) => m.caseId === 'duplicate-wire').at(-1)!.amountCents;
  assert.equal(-(tb.get(ACCOUNTS.UNAPPLIED_CASH) ?? 0), saltmarsh + ostravaSecond);
});

test('the ACH return and overnight cash are not booked yet', () => {
  const unbooked = ds.movements.filter((m) => m.kind === 'ach_return' || m.valueDate >= '2026-03-02').map((m) => m.id);
  assert.ok(unbooked.length > 0);
  assert.ok(journals.every((j) => !unbooked.includes(j.ref)));
});
