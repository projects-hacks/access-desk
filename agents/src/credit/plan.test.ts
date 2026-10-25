import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askWith } from '../llm';
import { decideCompany, emptyContext } from './decide';
import { loadFixture, verdicts } from './fixture';
import { assess, type PrecedentRow, type WorkItemRow } from './plan';
import { flagsFromRows, reviewProposal, subjectOf, viewOf } from './proposals';

const ORCHARD = 'ORG-90518', HALCYON = 'ORG-90101', JUNIPER = 'ORG-90677', KESTREL = 'ORG-90412';

const books = loadFixture();
const result = verdicts(books);

const inputs = (cid: string, workItems: WorkItemRow[] = [], precedents: PrecedentRow[] = []) => {
  const v = result.get(cid)!;
  return { book: v.book, scores: v.scores, flagRows: [], workItems, precedents, policies: [] };
};

const item = (id: bigint, cid: string, subjectId: string, state: string, view?: string, kind = 'CREDIT_REVIEW'): WorkItemRow => ({
  id, kind, clientId: cid, subjectId, state, proposalJson: JSON.stringify(view ? { view } : {}),
});

const rejection = (id: bigint, decidedOn: string): PrecedentRow => ({
  clientId: ORCHARD, workItemId: id, decidedOn, situation: '', proposed: '', decision: 'Rejected', overrideReason: '', outcome: '', policyRef: '', source: 'live',
});

const ORCHARD_SUBJECT = 'tier:ORG-90518:3->5';

test('nothing is held when nothing is open', () => {
  const a = assess(inputs(ORCHARD));
  assert.equal(a.held, false);
  assert.equal(viewOf(a.baseline), ORCHARD_SUBJECT);
  assert.deepEqual(a.withdraw, []);
});

test('a proposal waiting on a controller holds the same view', () => {
  for (const state of ['PROPOSED', 'NEEDS_INFO']) {
    const a = assess(inputs(ORCHARD, [item(1n, ORCHARD, ORCHARD_SUBJECT, state)]));
    assert.equal(a.held, true);
    assert.ok(a.openSubjects.has(ORCHARD_SUBJECT));
  }
});

test('a tier change that was applied does not hold anything', () => {
  assert.equal(assess(inputs(ORCHARD, [item(1n, ORCHARD, ORCHARD_SUBJECT, 'POSTED')])).held, false);
});

test('a review a controller already decided is not asked for again', () => {
  const a = assess(inputs(HALCYON, [item(1n, HALCYON, `review:${HALCYON}`, 'APPROVED')]));
  assert.equal(a.held, true);
});

test('a newer view of the client withdraws its open review', () => {
  const stale = item(9n, ORCHARD, 'tier:ORG-90518:3->4', 'PROPOSED', 'tier:ORG-90518:3->4');
  const a = assess(inputs(ORCHARD, [stale]));
  assert.deepEqual(a.withdraw.map((w) => w.id), [9n]);
  assert.equal(a.held, false);
  // An applied or rejected one is history, not a thing to withdraw.
  assert.deepEqual(assess(inputs(ORCHARD, [{ ...stale, state: 'APPROVED' }])).withdraw, []);
});

test('a rejection is remembered for 30 sim days', () => {
  const rejected = [item(7n, ORCHARD, ORCHARD_SUBJECT, 'REJECTED')];
  assert.equal(assess(inputs(ORCHARD, rejected, [rejection(7n, '2026-02-20')])).held, true);
  assert.equal(assess(inputs(ORCHARD, rejected, [rejection(7n, '2026-01-20')])).held, false);
  // A rejection of a different view does not hold this one.
  assert.equal(assess(inputs(ORCHARD, [item(7n, ORCHARD, 'tier:ORG-90518:3->4', 'REJECTED', 'tier:ORG-90518:3->4')], [rejection(7n, '2026-02-20')])).held, false);
});

test('an open policy draft is known to the model', () => {
  const draft = item(5n, JUNIPER, 'policy:pol-020:ORG-90677@1', 'PROPOSED', undefined, 'POLICY_DRAFT');
  assert.equal(assess(inputs(JUNIPER, [draft])).ctx.openDraft, true);
  assert.equal(assess(inputs(JUNIPER, [{ ...draft, state: 'REJECTED' }])).ctx.openDraft, false);
});

test('the rules decide the proposal a controller sees', async () => {
  const v = result.get(ORCHARD)!;
  const o = await decideCompany({ book: v.book, scores: v.scores, flags: v.flags, baseline: v.baseline, ctx: emptyContext() }, askWith([]));
  const p = reviewProposal(v.book, v.scores, v.flags, o, subjectOf(o.final)!);
  assert.equal(p.title, 'Orchard Treasury: tier 3 → 5');
  assert.equal(p.policyRef, 'pol-020');
  assert.equal(p.requiredRole, 'CONTROLLER');
  for (const k of ['action', 'from_tier', 'to_tier', 'reliability', 'value', 'coverage_ratio', 'breakdown', 'flags', 'expected_settle_on', 'decided_by', 'baseline', 'choice', 'guardrails']) {
    assert.ok(k in p.proposal, k);
  }
  assert.equal(p.proposal.decided_by, 'rules');
  assert.equal(p.proposal.choice, null);
  assert.deepEqual(p.proposal.flags, ['dispute_delay']);
  assert.equal(p.proposal.view, ORCHARD_SUBJECT);
  assert.ok(p.reasoning.includes('dispute_delay')); // the template reasoning cites the flag
  const h = result.get(HALCYON)!;
  const ho = await decideCompany({ book: h.book, scores: h.scores, flags: h.flags, baseline: h.baseline, ctx: emptyContext() }, askWith([]));
  assert.equal(reviewProposal(h.book, h.scores, h.flags, ho, subjectOf(ho.final)!).title, 'Halcyon Capital: review strategic tier');
});

test("flags come from ExploitWatch's rows when it has some", () => {
  const v = result.get(JUNIPER)!;
  const row = {
    id: `restriction_eve:${JUNIPER}`, pattern: 'restriction_eve', score: 1, status: 'flagged', months: 14,
    evidenceJson: JSON.stringify([{ invoice_id: v.book.invoices[0]!.id, note: 'paid on day 20' }, { invoice_id: 'INV-NOPE', note: 'unknown invoice' }]), proposedFix: 'prepay',
  };
  const [flag] = flagsFromRows(v.book, [row]);
  assert.equal(flag!.pattern, 'restriction_eve');
  assert.equal(flag!.evidence.length, 1); // an invoice the book doesn't have is dropped
  assert.ok(flag!.evidence[0]!.dpd >= 0);
  assert.deepEqual(flagsFromRows(v.book, [{ ...row, status: 'cleared' }]), []);
  const withRows = assess({ ...inputs(JUNIPER), flagRows: [row] });
  assert.deepEqual(withRows.flags.map((f) => f.pattern), ['restriction_eve']);
  // A cleared row beats the fallback detectors; a client with no rows still gets them.
  assert.deepEqual(assess({ ...inputs(JUNIPER), flagRows: [{ ...row, status: 'cleared' }] }).flags, []);
  assert.deepEqual(assess(inputs(KESTREL)).flags.filter((f) => f.fired).map((f) => f.pattern), ['recent_late']);
});
