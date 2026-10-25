import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect } from './detectors';
import { billingOf, loadFixture, verdicts } from './fixture';
import type { ClientBook, Dispute } from './model';
import { reliability, scoreBook, wholeScore } from './scoring';
import { decide } from './tiers';

/** Rajeev's dataset (fixtures/book.json, the demo morning) and the tier each client should get, set by hand. client -> [tier now, expected "stay" | "review" | new tier] */
const KEY: Record<string, [number, string | number]> = {
  'ORG-90101': [1, 'review'], // Halcyon
  'ORG-90107': [1, 'stay'], // Redwing
  'ORG-90118': [1, 'stay'], // Aster Point
  'ORG-90142': [2, 1], // Meridian Flow
  'ORG-90164': [2, 1], // Silverline
  'ORG-90176': [3, 'stay'], // Northfold
  'ORG-90229': [2, 3], // Fieldstone
  'ORG-90233': [2, 'stay'], // Bluefin
  'ORG-90244': [2, 'stay'], // Basalt
  'ORG-90251': [2, 'stay'], // Cinder Peak
  'ORG-90287': [2, 'stay'], // Tidewater
  'ORG-90302': [2, 'stay'], // Polaris
  'ORG-90355': [3, 'stay'], // Cobalt Ridge: held by the 3-point margin
  'ORG-90366': [2, 'stay'], // Copperline
  'ORG-90378': [3, 2], // Harbor & Pine
  'ORG-90391': [3, 2], // Granite Bay
  'ORG-90399': [3, 2], // Larkspur
  'ORG-90412': [3, 'stay'], // Kestrel: recent_late
  'ORG-90431': [3, 'stay'], // Ostrava: held by margin
  'ORG-90455': [4, 'stay'], // Ember Street: held by margin
  'ORG-90463': [3, 'stay'], // Ivory Lane: one miss, no flag
  'ORG-90518': [3, 5], // Orchard: dispute_delay
  'ORG-90612': [4, 'stay'], // Saltmarsh
  'ORG-90677': [4, 'stay'], // Juniper: restriction_eve
  'ORG-90689': [3, 2], // Quillon
  'ORG-90731': [3, 'stay'], // Lantern
  'ORG-90744': [4, 5], // Wrenfield: partial_reset
  'ORG-90758': [4, 'stay'], // Monarch: pays_restricted_only
  'ORG-90802': [5, 'stay'], // Vantage Loop
  'ORG-90816': [5, 'stay'], // Tessellate
};

// Fieldstone's recent_late only fires once the 2026-03-02 lump sum is applied (not in the fixture).
const FLAGS = new Set([
  'quarter_end:ORG-90101', 'recent_late:ORG-90412', 'dispute_delay:ORG-90518', 'restriction_eve:ORG-90677', 'partial_reset:ORG-90744', 'pays_restricted_only:ORG-90758',
]);

/** Approximate scores from the plan: [reliability, value]. */
const SCORES: Record<string, [number, number]> = {
  'ORG-90101': [53, 98], 'ORG-90518': [42, 40], 'ORG-90677': [65, 44], 'ORG-90412': [80, 73], 'ORG-90142': [93, 84],
};

const books = loadFixture();
const result = verdicts(books);
const get = (id: string) => result.get(id)!;
const bookOf = (id: string) => get(id).book;

test('the fixture is the demo morning', () => {
  assert.equal(books.length, 30);
  assert.deepEqual(new Set(books.map((b) => b.today)), new Set(['2026-03-03']));
  assert.deepEqual(Object.fromEntries(books.map((b) => [b.client.id, b.client.tier])), Object.fromEntries(Object.entries(KEY).map(([k, v]) => [k, v[0]])));
});

for (const [id, [, expected]] of Object.entries(KEY)) {
  test(`tier matches the answer key: ${id}`, () => {
    const d = get(id).baseline;
    assert.equal(d.action === 'tier_change' ? d.toTier : d.action, expected, `${d.reasons.join(' | ')}`);
  });
}

test('nine changes and one review', () => {
  const actions = [...result.values()].map((v) => v.baseline.action);
  assert.equal(actions.filter((a) => a === 'tier_change').length, 9);
  assert.equal(actions.filter((a) => a === 'review').length, 1);
  assert.equal(actions.filter((a) => a === 'stay').length, 20);
});

test('exactly the planted flags', () => {
  const fired = new Set([...result].flatMap(([cid, v]) => v.flags.filter((f) => f.fired).map((f) => `${f.pattern}:${cid}`)));
  assert.deepEqual(fired, FLAGS);
});

test('flag evidence matches the plan', () => {
  const measured = Object.fromEntries([...result.values()].flatMap((v) => v.flags.filter((f) => f.fired).map((f) => [f.pattern, f])));
  assert.ok(measured.restriction_eve!.measured.startsWith('14 of 14 '));
  assert.equal(measured.partial_reset!.evidence.length, 11);
  assert.ok(measured.pays_restricted_only!.measured.includes('API day 2, CUSTODY day 30'));
  assert.ok(measured.recent_late!.measured.startsWith('last 3 months 12, 18, 9 days late'));
  assert.ok(measured.dispute_delay!.measured.startsWith('11 of 11 months disputed, 22 of 22'));
});

for (const [id, [rel, val]] of Object.entries(SCORES)) {
  test(`scores near the plan: ${id}`, () => {
    const s = get(id).scores;
    assert.ok(Math.abs(s.reliability - rel) <= 1.5, `reliability ${s.reliability}`);
    assert.ok(Math.abs(s.value - val) <= 1.5, `value ${s.value}`);
  });
}

test('same input gives identical output', () => {
  const again = verdicts(loadFixture());
  for (const [id, v] of result) assert.deepEqual(again.get(id)!.baseline, v.baseline);
});

test('strategic clients never get a tier change', () => {
  for (const v of result.values()) if (v.book.client.strategic) assert.notEqual(v.baseline.action, 'tier_change');
  assert.equal(get('ORG-90101').baseline.action, 'review');
  assert.equal(get('ORG-90101').baseline.policyRef, 'pol-022');
});

test('Kestrel is not upgraded while recent_late fires', () => {
  assert.equal(get('ORG-90412').baseline.action, 'stay');
  // At tier 4 its formula (3) would be an upgrade; recent_late blocks it.
  const kestrel = bookOf('ORG-90412');
  const higher: ClientBook = { ...kestrel, client: { ...kestrel.client, tier: 4 } };
  const d = decide(higher, get('ORG-90412').scores, get('ORG-90412').flags);
  assert.deepEqual([d.formula, d.action], [3, 'stay']);
  assert.ok(d.reasons.includes('upgrade blocked: recent_late fired'));
});

for (const id of ['ORG-90355', 'ORG-90431', 'ORG-90455']) {
  test(`held by the three-point margin: ${id}`, () => {
    const d = get(id).baseline;
    assert.ok(d.formula < d.current && d.action === 'stay');
    assert.ok(d.reasons.some((r) => r.includes('within 3 points')));
  });
}

test('a credited dispute costs nothing, an upheld one costs a point and a half', () => {
  const meridian = bookOf('ORG-90142');
  const withDispute = (resolution: string): ClientBook => {
    const inv = meridian.invoices.find((i) => i.status === 'paid')!;
    const extra: Dispute = { id: 'DSP-T', invoiceId: inv.id, openedOn: inv.dueOn, resolvedOn: inv.dueOn, resolution, status: 'resolved' };
    return { ...meridian, disputes: [...meridian.disputes, extra] };
  };
  const base = reliability(meridian).parts.disputes;
  assert.equal(reliability(withDispute('credited')).parts.disputes, 0);
  assert.equal(base, 0);
  assert.equal(reliability(withDispute('no_change')).parts.disputes, 1.5);
});

test('a replay reads nothing after its date', () => {
  const cutoff = '2025-12-31';
  const replay = loadFixture(cutoff);
  for (const b of replay) {
    assert.equal(b.today, cutoff);
    for (const i of b.invoices) {
      assert.ok(i.issuedOn <= cutoff);
      assert.ok(i.payments.every((p) => p.valueOn <= cutoff));
      assert.ok(i.paidOn === null || i.paidOn <= cutoff);
    }
    for (const d of b.disputes) {
      assert.ok(d.openedOn <= cutoff);
      assert.ok(d.resolvedOn === null || d.resolvedOn <= cutoff);
    }
  }
  // Every January payment in the live book really is gone from the replay.
  assert.ok(books.some((b) => b.invoices.some((i) => i.payments.some((p) => p.valueOn.startsWith('2026')))));
  assert.ok(verdicts(replay).size === 30);
});

test('profiles are whole scores between 0 and 100 for every client', () => {
  for (const v of result.values()) {
    for (const x of [wholeScore(v.scores.reliability), wholeScore(v.scores.value)]) assert.ok(Number.isInteger(x) && x >= 0 && x <= 100);
  }
  assert.equal(wholeScore(52.5), 52);
  assert.equal(wholeScore(53.5), 54);
  assert.equal(wholeScore(120), 100);
});

test('Fieldstone slides to tier 3 after the 2026-03-02 lump sum', () => {
  const fieldstone = bookOf('ORG-90229');
  const paid = fieldstone.invoices.map((i) => (i.status === 'open' && i.period !== '2026-02'
    ? { ...i, paidCents: i.amountCents, paidOn: '2026-03-02', status: 'paid', payments: [{ valueOn: '2026-03-02', amountCents: i.amountCents }] } : i));
  const after: ClientBook = { ...fieldstone, invoices: paid };
  const all = books.map((b) => (b.client.id === 'ORG-90229' ? after : b));
  const scores = scoreBook(after, billingOf(all));
  const flags = detect(after);
  assert.deepEqual(flags.filter((f) => f.fired).map((f) => f.pattern), ['recent_late']);
  const d = decide(after, scores, flags);
  assert.deepEqual([d.action, d.toTier], ['tier_change', 3]);
});

test('Saltmarsh is upgraded once its Feb 19 cash is applied', () => {
  const salt = bookOf('ORG-90612');
  const paid = salt.invoices.map((i) => (i.period === '2026-01'
    ? { ...i, paidCents: i.amountCents, paidOn: '2026-02-19', status: 'paid', payments: [{ valueOn: '2026-02-19', amountCents: i.amountCents }] } : i));
  const after: ClientBook = { ...salt, invoices: paid };
  const all = books.map((b) => (b.client.id === 'ORG-90612' ? after : b));
  const s = scoreBook(after, billingOf(all));
  const d = decide(after, s, detect(after));
  assert.ok(s.reliability > 73); // clears the 70 line by the 3-point margin
  assert.deepEqual([d.action, d.toTier], ['tier_change', 3]);
});
