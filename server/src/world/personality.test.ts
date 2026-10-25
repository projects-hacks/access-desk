import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDataset } from '../dataset';
import { deriveProfiles, quarterEndOnOrAfter, readyOn, type Profile } from './personality';

const ds = loadDataset();
const profiles = deriveProfiles(ds);
const of = (name: string) => [...profiles.values()].find((p) => p.name === name)!;

test('personalities come from each client\'s own history and January story', () => {
  const expected: Record<string, string> = {
    'Halcyon Capital': 'quarter_end',
    'Juniper Labs': 'gamer',
    'Orchard Treasury': 'disputer',
    'Wrenfield Digital': 'partial',
    'Vantage Loop': 'delinquent',
    'Lantern Payments': 'delinquent',
    'Ember Street Capital': 'slow',
    'Bluefin Arbitrage': 'on_time',
    'Redwing Liquidity': 'on_time',
  };
  for (const [name, personality] of Object.entries(expected)) assert.equal(of(name).personality, personality, name);
});

test('habits that come with the January story: rail, reference, affiliates, currency of the wire', () => {
  assert.equal(of('Quillon Systems').rail, 'ACH');
  assert.equal(of('Kestrel Quant').affiliateKey, 'zephyr');
  assert.equal(of('Basalt Global Macro').affiliateKey, 'basalt-feeder');
  assert.equal(of('Ostrava Digital Assets').international, true);
  assert.equal(of('Fieldstone Quant').reference, 'client');
  assert.deepEqual([of('Copperline Treasury').reference, of('Copperline Treasury').memoName], ['none', 'COPPERLINE TRSY']);
  assert.equal(of('Northfold Trading').overpays, true);
  assert.equal(of('Granite Bay Holdings').duplicates, true);
});

test('most clients are the kind that pays on time, a handful are not', () => {
  const count = (k: string) => [...profiles.values()].filter((p) => p.personality === k).length;
  assert.ok(count('on_time') >= 15, `on_time ${count('on_time')}`);
  assert.ok(count('delinquent') >= 2 && count('delinquent') <= 5);
  assert.ok(count('gamer') >= 1);
  assert.equal(profiles.size, ds.clients.length);
});

const profile = (personality: Profile['personality'], medianLate = 0): Profile => ({
  clientId: 'ORG-X', name: 'X', personality, medianLate, rail: 'WIRE', reference: 'invoices', international: false, overpays: false, duplicates: false, typos: false,
});
const inv = (n: number, dueOn: string, paidCents = 0) => ({ id: `INV-${n}`, dueOn, paidCents });

test('when a client pays an invoice is stable, and bounded by its personality', () => {
  for (let n = 1; n <= 200; n++) {
    const i = inv(n, '2026-04-10');
    assert.equal(readyOn(profile('on_time'), i), readyOn(profile('on_time'), i));
    const onTime = readyOn(profile('on_time'), i)!;
    assert.ok(onTime <= '2026-04-11' && onTime >= '2026-04-04', onTime);
    const disputer = readyOn(profile('disputer'), i)!;
    assert.ok(disputer >= '2026-05-07' && disputer <= '2026-05-11', disputer);
    assert.ok(readyOn(profile('delinquent'), i)! >= '2026-06-09');
  }
});

test('a gamer waits for the cure period and pays the day before it ends', () => {
  const i = inv(1, '2026-04-10');
  assert.equal(readyOn(profile('gamer', 20), i), undefined);
  assert.equal(readyOn(profile('gamer', 20), i, { state: 'running', dueOn: '2026-05-05' }), '2026-05-04');
  assert.equal(readyOn(profile('gamer', 20), i, { state: 'expired', dueOn: '2026-05-05' }), '2026-04-10');
});

test('a partial payer sends the rest weeks after the first half; quarter-end payers wait for the quarter', () => {
  const first = readyOn(profile('partial'), inv(1, '2026-04-10'))!;
  const rest = readyOn(profile('partial'), inv(1, '2026-04-10', 5000))!;
  assert.ok(rest > first && rest === '2026-05-12');
  assert.equal(quarterEndOnOrAfter('2026-03-31'), '2026-03-31');
  assert.equal(quarterEndOnOrAfter('2026-05-01'), '2026-06-30');
  assert.equal(quarterEndOnOrAfter('2026-12-31'), '2026-12-31');
  assert.equal(quarterEndOnOrAfter('2027-01-05'), '2027-03-31');
  assert.equal(readyOn(profile('quarter_end'), inv(1, '2026-05-01')), '2026-06-30');
});
