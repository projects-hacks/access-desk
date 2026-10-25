import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askWith, type Provider } from '../llm';
import { evaluate, parsePolicies, type PolicyRow } from './company';
import { attention, decideCompany, emptyContext, evidenceIds, type CompanyContext, type Request } from './decide';
import { fromBaseline, violations } from './guardrails';
import { loadFixture, verdicts } from './fixture';
import { assess } from './plan';
import { keptTier, policyDraft } from './proposals';

const HALCYON = 'ORG-90101', MERIDIAN = 'ORG-90142', KESTREL = 'ORG-90412', JUNIPER = 'ORG-90677', IVORY = 'ORG-90463';

const books = loadFixture();
const result = verdicts(books);

/** Replies per client, one per attempt; a client without a script gets an outage. */
function claude(script: Record<string, unknown[]>) {
  const calls: { cid: string; prompt: string }[] = [];
  const p: Provider = {
    name: 'factory',
    async answer(prompt) {
      const cid = /"id": "(ORG-\d+)"/.exec(prompt)![1]!;
      const n = calls.filter((c) => c.cid === cid).length;
      calls.push({ cid, prompt });
      const replies = script[cid];
      if (!replies?.length) throw new Error('no scripted reply');
      return JSON.stringify(replies[Math.min(n, replies.length - 1)]);
    },
  };
  return { ask: askWith([p]), calls };
}

const decision = (action = 'stay', to_tier = 1, over: Record<string, unknown> = {}) => ({
  action, to_tier, policy: null, reasons: ['because'], cited_invoice_ids: [], confidence: 0.8, ...over,
});

const draft = (over: Record<string, unknown> = {}) => ({
  kind: 'company_draft', policy_id: 'pol-020', title: 'Prepay on the due date',
  terms: [{ lever: 'prepay', value: null, at_renewal: false }, { lever: 'cure_days', value: 5, at_renewal: true }],
  success_criteria: [
    { metric: 'share_paid_within_grace', target: 0.8, pattern: null, window_months: 3 },
    { metric: 'pattern_not_firing', target: 0, pattern: 'restriction_eve', window_months: 6 },
  ],
  ...over,
});

function request(cid: string, ctx: Partial<CompanyContext> = {}): Request {
  const v = result.get(cid)!;
  return { book: v.book, scores: v.scores, flags: v.flags, baseline: v.baseline, ctx: { ...emptyContext(), ...ctx } };
}

const firstInvoice = (cid: string) => result.get(cid)!.book.invoices[0]!.id;

test('without a model the rules decide, and nobody is asked', async () => {
  const r = request(KESTREL);
  const o = await decideCompany(r, askWith([]));
  assert.equal(o.decidedBy, 'rules');
  assert.deepEqual(o.final, r.baseline);
});

test('a quiet company gets no call', async () => {
  const r = request('ORG-90107'); // Redwing: stays, no flags
  assert.equal(attention(r.baseline, r.flags, r.ctx), undefined);
  const { ask, calls } = claude({});
  const o = await decideCompany(r, ask);
  assert.equal(o.decidedBy, 'rules');
  assert.equal(calls.length, 0);
});

test('the rules baseline respects the tier guardrails', () => {
  for (const [id, v] of result) {
    const r = request(id);
    const found = violations(v.book, v.flags, fromBaseline(v.baseline), evidenceIds(v.book), new Set(['pol-020', 'pol-021', 'pol-022']));
    assert.deepEqual(found.filter((x) => !x.startsWith('citations')), [], v.book.client.name + r.book.client.id);
  }
});

const BREAKS: [string, string, Record<string, unknown>, string][] = [
  ['strategic client, tier change', HALCYON, decision('tier_change', 2, { cited_invoice_ids: ['*'] }), 'strategic'],
  ['too many steps down', MERIDIAN, decision('tier_change', 5, { cited_invoice_ids: ['*'] }), 'max_down'],
  ['citing an invoice that is not in the facts', MERIDIAN, decision('stay', 2, { cited_invoice_ids: ['INV-9999'] }), 'citations'],
  ['a lever the contract does not allow', KESTREL, decision('stay', 3, { policy: draft(), cited_invoice_ids: ['*'] }), 'lever_prepay'],
  ['an upgrade while recent_late fires', KESTREL, decision('tier_change', 2, { cited_invoice_ids: ['*'] }), 'recent_late'],
  ['a grace period outside its bounds', JUNIPER, decision('tier_change', 3, { policy: draft({ terms: [{ lever: 'grace_days', value: 30, at_renewal: false }] }), cited_invoice_ids: ['*'] }), 'lever_grace'],
];
for (const [name, cid, bad, rule] of BREAKS) {
  test(`a decision that breaks a guardrail is asked again, then the rules decide: ${name}`, async () => {
    const r = request(cid);
    const reply = { ...bad, cited_invoice_ids: (bad.cited_invoice_ids as string[]).map((i) => (i === '*' ? firstInvoice(cid) : i)) };
    const { ask, calls } = claude({ [cid]: [reply, reply] });
    const o = await decideCompany(r, ask);
    assert.equal(o.decidedBy, 'rules');
    assert.deepEqual(o.final, r.baseline);
    assert.equal(calls.length, 2);
    assert.equal(o.attempts.length, 2);
    assert.ok(o.attempts[0]!.violations.some((v) => v.startsWith(rule)), o.attempts[0]!.violations.join('|'));
    assert.match(calls[1]!.prompt, new RegExp(`That decision was rejected[\\s\\S]*${rule}`));
  });
}

test('a corrected answer on the retry is accepted', async () => {
  const r = request(MERIDIAN);
  const inv = r.book.invoices.at(-4)!.id;
  const { ask } = claude({ [MERIDIAN]: [decision('tier_change', 5, { cited_invoice_ids: [inv] }), decision('stay', 2, { cited_invoice_ids: [inv], reasons: ['hold a quarter'] })] });
  const o = await decideCompany(r, ask);
  assert.equal(o.decidedBy, 'claude');
  assert.equal(o.provider, 'factory');
  assert.equal(o.final.action, 'stay');
  assert.ok(o.attempts[0]!.violations.length && !o.attempts[1]!.violations.length);
});

test('an answer that is not a decision counts as a violation', async () => {
  const { ask } = claude({ [MERIDIAN]: [{ action: 'upgrade' }, { nope: 1 }] });
  const o = await decideCompany(request(MERIDIAN), ask);
  assert.equal(o.decidedBy, 'rules');
  assert.equal(o.attempts[0]!.error, 'invalid JSON');
  assert.ok(o.attempts[0]!.violations.some((v) => v.startsWith('schema: action')));
});

test('an outage falls back to the rules without a retry', async () => {
  const { ask, calls } = claude({});
  const o = await decideCompany(request(MERIDIAN), ask);
  assert.equal(o.decidedBy, 'rules');
  assert.match(o.why, /no model answered/);
  assert.equal(calls.length, 1);
});

function junipersReply() {
  const ids = result.get(JUNIPER)!.book.invoices.filter((i) => i.status === 'paid').slice(-6).map((i) => i.id);
  return decision('stay', 4, {
    policy: draft(), cited_invoice_ids: ids, confidence: 0.85,
    reasons: ['14 of 14 single payments landed on day 20, the day before restriction.', "A lower tier doesn't change that; prepay and a 5-day cure at renewal do."],
  });
}

test("the model's choice replaces the baseline and drafts a policy", async () => {
  const r = request(JUNIPER);
  const { ask } = claude({ [JUNIPER]: [junipersReply()] });
  const o = await decideCompany(r, ask);
  assert.equal(o.decidedBy, 'claude');
  assert.equal(o.final.action, 'stay');
  const d = policyDraft(r.book, r.scores, o, [], '2026-03-03');
  assert.equal(d.policyId, `pol-020:${JUNIPER}`);
  assert.equal(d.version, 1);
  const rule = JSON.parse(d.ruleJson);
  assert.equal(rule.terms[0].lever, 'prepay');
  assert.equal(rule.success_criteria[0].target, 0.8);
  const p = d.proposal;
  assert.equal(p.kind, 'POLICY_DRAFT');
  assert.equal(p.subjectId, `policy:pol-020:${JUNIPER}@1`);
  assert.equal(p.requiredRole, 'CONTROLLER');
  assert.equal(p.title, 'Juniper Labs: Prepay on the due date');
  assert.equal(p.proposal.decided_by, 'claude');
  assert.equal(p.proposal.provider, 'factory');
  assert.equal(p.proposal.policy_key, `pol-020:${JUNIPER}@1`);
  assert.equal((p.proposal.baseline as { action: string }).action, 'stay');
  assert.ok((p.proposal.guardrails as string[]).includes('flag cap: restriction_eve fired, tier no better than 3'));
  assert.match(p.reasoning, /^- Change: prepay required\.$/m);
  assert.match(p.reasoning, /^- Change: cure period of 5 days at renewal\.$/m);
  assert.match(p.reasoning, /^- Works if: 80% of invoices paid within grace over 3 months\.$/m);
  assert.match(p.reasoning, /^- Works if: no more payments timed to the day before a restriction over 6 months\.$/m);
  assert.doesNotMatch(p.reasoning, /[—;]/);
});

test('a company policy that was already activated gets the next version', () => {
  const rows: PolicyRow[] = [{ key: `pol-020:${JUNIPER}@1`, policyId: `pol-020:${JUNIPER}`, version: 1, status: 'active', title: 'x', ruleJson: '{}' }];
  const r = request(JUNIPER);
  const o = {
    clientId: JUNIPER, decidedBy: 'claude' as const, provider: 'factory', model: 'm', why: '', baseline: r.baseline, final: r.baseline, guardrails: [], attempts: [],
    choice: junipersReply() as never,
  };
  assert.equal(policyDraft(r.book, r.scores, o, rows, '2026-03-03').version, 2);
});

test('a tier the model kept against the rules is described once, with its reason', async () => {
  const r = request(MERIDIAN);
  const { ask } = claude({ [MERIDIAN]: [decision('stay', 2, { reasons: ['Too early to move it up.'] })] });
  const o = await decideCompany(r, ask);
  const kept = keptTier(r.book, o)!;
  assert.equal(kept.code, 'claude_kept_tier:tier_change:1');
  assert.ok(kept.reason.startsWith('Kept tier 2; the rules proposed a move to tier 1.'));
  assert.ok(kept.reason.includes('Too early to move it up.'));
  // Agreeing with the rules, or falling back to them, keeps nothing.
  assert.equal(keptTier(r.book, await decideCompany(r, askWith([]))), undefined);
});

// ── Evaluator and the learning loop ─────────────────────────────────────────

const active = (cid: string, criteria: object[], effectiveOn: string): PolicyRow => ({
  key: `pol-020:${cid}@1`, policyId: `pol-020:${cid}`, version: 1, status: 'active', title: 'company policy',
  ruleJson: JSON.stringify({ success_criteria: criteria, effective_on: effectiveOn, work_item_id: 41 }),
});
const SHARE = { metric: 'share_paid_within_grace', target: 0.8, pattern: null, window_months: 6 };
const MEAN = { metric: 'mean_days_late', target: 25, pattern: null, window_months: 6 };
const WORST = { metric: 'max_days_late', target: 10, pattern: null, window_months: 6 };

test('the policy evaluator is deterministic', () => {
  const [fail] = parsePolicies([active(JUNIPER, [SHARE, MEAN], '2025-11-01')]);
  const e = evaluate(result.get(JUNIPER)!.book, fail!);
  assert.equal(e.status, 'failing');
  assert.deepEqual(e.results.map((x) => x.passed), [false, true]);
  assert.ok(e.results[0]!.text.startsWith('0 of 8 paid within 5 days'));
  assert.deepEqual(evaluate(result.get(JUNIPER)!.book, fail!), e);
  const [ok] = parsePolicies([active(MERIDIAN, [SHARE], '2025-11-15')]);
  assert.equal(evaluate(result.get(MERIDIAN)!.book, ok!).status, 'passing');
  const [fresh] = parsePolicies([active(MERIDIAN, [SHARE], '2026-03-01')]);
  assert.equal(evaluate(result.get(MERIDIAN)!.book, fresh!).status, 'pending');
});

test('a failing company policy brings a quiet company back to the model', async () => {
  const v = result.get(IVORY)!;
  const a = assess({ book: v.book, scores: v.scores, flagRows: [], workItems: [], precedents: [], policies: [active(IVORY, [WORST], '2025-12-01')] });
  assert.equal(a.ctx.evaluations[0]!.status, 'failing');
  assert.match(attention(a.baseline, a.flags, a.ctx) ?? '', /company policy failing: pol-020:ORG-90463@1/);
  const { ask, calls } = claude({});
  await decideCompany({ book: v.book, scores: v.scores, flags: a.flags, baseline: a.baseline, ctx: a.ctx }, ask);
  assert.equal(calls[0]!.cid, IVORY);
  assert.match(calls[0]!.prompt, /"status": "failing"[\s\S]*worst 41 days late/);
});
