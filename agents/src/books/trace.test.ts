import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECEIVABLES, UNAPPLIED_CASH, correctionFor, findCauses, likelyOwners, type BooksFacts, type Movement } from './trace';

const mv = (o: Partial<Movement> & Pick<Movement, 'id' | 'bankRef' | 'direction' | 'amountCents'>): Movement => ({
  isHistory: false, matchStatus: 'matched', rail: 'ACH', origName: '', origAccount: '', refs: [], platformAccount: 'collections', ...o,
});

function returnedTwice(): BooksFacts {
  return {
    off: new Map([['receivables', -1_627_000n], ['unapplied', -1_627_000n]]),
    movements: [
      mv({ id: 'in1', bankRef: 'AC-8001', direction: 'in', amountCents: 1_627_000n, matchStatus: 'reversed' }),
      mv({ id: 'out1', bankRef: 'AC-8002', direction: 'out', amountCents: 1_627_000n, reverses: 'AC-8001' }),
    ],
    applications: [{ id: 1n, movementId: 'in1', method: 'exact', reversed: true, amountCents: 1_627_000n }],
    ledger: [
      { journalId: 'JE-R-AC-8002', accountCode: RECEIVABLES, debitCents: 1_627_000n, creditCents: 0n, ref: 'AC-8002' },
      { journalId: 'JE-R-AC-8002', accountCode: '1010', debitCents: 0n, creditCents: 1_627_000n, ref: 'AC-8002' },
    ],
    pending: new Set(),
  };
}

test('a return of cash we applied, booked to receivables twice, is found and closes the gap exactly', () => {
  const f = returnedTwice();
  const found = findCauses(f);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.amountCents, 1_627_000n);
  const fix = correctionFor(f, found);
  assert.equal(fix.closes, true);
  assert.deepEqual(fix.lines, [
    { account: UNAPPLIED_CASH, debitCents: 1_627_000n, creditCents: 0n },
    { account: RECEIVABLES, debitCents: 0n, creditCents: 1_627_000n },
  ]);
});

test('a return already corrected is not corrected again', () => {
  const f = returnedTwice();
  f.ledger.push({ journalId: 'JE-ADJ-W90', accountCode: RECEIVABLES, debitCents: 0n, creditCents: 1_627_000n, ref: 'AC-8002' });
  assert.equal(findCauses(f).length, 0);
});

test('an applied payment whose journal never posted is found, unless it is still queued', () => {
  const f: BooksFacts = {
    off: new Map([['receivables', -500_000n], ['unapplied', -500_000n]]),
    movements: [mv({ id: 'in2', bankRef: 'WI-6001', direction: 'in', amountCents: 500_000n, rail: 'WIRE' })],
    applications: [{ id: 7n, movementId: 'in2', method: 'exact', reversed: false, amountCents: 500_000n }],
    ledger: [],
    pending: new Set(),
  };
  assert.equal(findCauses(f)[0]!.ref, 'WI-6001');
  f.pending.add('JE-AP-WI-6001-7');
  assert.equal(findCauses(f).length, 0);
});

test('a partial explanation does not claim to close the gap', () => {
  const f = returnedTwice();
  f.off.set('receivables', -2_000_000n);
  assert.equal(correctionFor(f, findCauses(f)).closes, false);
});

test('likely owner: an invoice open for exactly the amount, from a sender with the same name, is strong', () => {
  const m = mv({ id: 'u1', bankRef: 'JD-0001', direction: 'in', amountCents: 940_000n, origName: 'HARBOR AND PINE TREASURY INC', matchStatus: 'exception' });
  const clients = [{ id: 'ORG-1', name: 'Harbor & Pine Treasury', legalName: 'Harbor and Pine Treasury Inc' }, { id: 'ORG-2', name: 'Kestrel', legalName: 'Kestrel Quant LLC' }];
  const owners = likelyOwners(m, clients, [{ id: 'INV-1', clientId: 'ORG-1', owedCents: 940_000n }, { id: 'INV-2', clientId: 'ORG-2', owedCents: 940_000n }]);
  assert.equal(owners.length, 2);
  assert.deepEqual(owners.filter((o) => o.strong).map((o) => o.client.id), ['ORG-1']);
});
