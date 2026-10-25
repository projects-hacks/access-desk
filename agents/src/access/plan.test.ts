import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { byKeywords } from './pushback';
import { PAID, HOLD_OFF, TODAY, event, invoicePaid, item, lever, note, only, planFor, reading, view, waited, wire } from './fixtures';
import type { Move } from './model';

const kind = (m: Move | undefined) => m?.kind;
const restriction = (m: Move | undefined) => {
  assert.equal(m?.kind, 'restriction');
  return m as Extract<Move, { kind: 'restriction' }>;
};
const notice = (m: Move | undefined) => {
  assert.equal(m?.kind, 'notice');
  return m as Extract<Move, { kind: 'notice' }>;
};
const levers = (...l: ReturnType<typeof lever>[]) => l;
const active = lever('withdrawals', 'active', 'Normal');
const otcPaused = lever('trading', 'limited', 'OTC paused');
const held = lever('withdrawals', 'limited', '$500.00 held');

describe('the ladder', () => {
  test('restricts the unpaid product, gentlest step first', () => {
    const m = restriction(only(view()));
    assert.deepEqual([m.lever, m.step], ['trading', 'PAUSE_OTC']);
  });

  test('no restriction while the cure period runs, or before any default notice', () => {
    assert.equal(only(view({ cure: 'open' })), undefined);
    assert.equal(only(view({ cure: null })), undefined);
  });

  test('collects from custody before restricting', () => {
    assert.equal(kind(only(view({ debit: true, usd: 100_000_000 }))), 'custody_debit');
  });

  test('a debit takes every invoice custody covers in one go, at any tier', () => {
    for (const tier of [1, 3]) {
      const v = view({ tier, debit: true, usd: 100_000_000, owed: [['INV-1', 'CUSTODY', 2_240_000], ['INV-2', 'TRADING', 6_400_000]] });
      assert.deepEqual((only(v) as { invoiceIds: string[] }).invoiceIds, ['INV-1', 'INV-2']);
    }
  });

  test('a debit stops where custody runs out', () => {
    const m = only(view({ debit: true, usd: 3_000_000, owed: [['INV-1', 'CUSTODY', 2_240_000], ['INV-2', 'TRADING', 6_400_000]] })) as { invoiceIds: string[]; reasoning: string };
    assert.deepEqual(m.invoiceIds, ['INV-1']);
    assert.match(m.reasoning, /Custody covers 1 of 2 overdue invoices/);
  });

  test('waits for a payment in transit and for an open promise to pay', () => {
    const transit = wire({ status: 'pending', match: 'in_transit', valueOn: '2026-03-19' });
    assert.equal(only(view({ cash: [transit], inTransit: [transit] })), undefined);
    const v = view();
    v.deadlines.push({ id: 2, kind: 'promise_to_pay', startedOn: TODAY, dueOn: '2026-03-25', status: 'open', note: '' });
    assert.equal(only(v), undefined);
  });

  test('one step at a time, spaced by the escalation days', () => {
    const l = levers(active, otcPaused);
    assert.equal(only(view({ levers: l, cureDue: '2026-03-15' })), undefined);
    const m = restriction(only(view({ levers: l, cureDue: '2026-03-01' })));
    assert.deepEqual([m.lever, m.step], ['withdrawals', 'HOLD_AMOUNT_OWED']);
    const both = levers(held, otcPaused);
    assert.equal(only(view({ levers: both, cureDue: '2026-03-01', approvals: [event('APPROVED', '2026-03-16', 5)] })), undefined);
    const next = restriction(only(view({ levers: both, cureDue: '2026-03-01', approvals: [event('APPROVED', '2026-03-12', 5)] })));
    assert.deepEqual([next.lever, next.step], ['trading', 'NO_NEW_POSITIONS']);
  });

  test('a hedged book is never set to close-only (pol-008)', () => {
    const l = levers(held, lever('trading', 'limited', 'No new positions · closing allowed'));
    assert.equal(only(view({ levers: l, cureDue: '2026-01-01', positions: [{ status: 'open', hedgeGroup: 'H1', notionalCents: 1 }] })), undefined);
    assert.equal(restriction(only(view({ levers: l, cureDue: '2026-01-01' }))).step, 'CLOSE_ONLY');
  });

  test('holds withdrawals first after a withdrawal during the cure period', () => {
    const m = restriction(only(view({ flags: [{ status: 'open', pattern: 'withdrawal_during_cure' }] })));
    assert.deepEqual([m.lever, m.step], ['withdrawals', 'HOLD_AMOUNT_OWED']);
  });

  test('no hold without a set-off right', () => {
    assert.equal(only(view({ products: ['CUSTODY'], owed: [['INV-1', 'CUSTODY', 10_000]], setOff: false })), undefined);
  });

  test('respects a controller rejection, until the client cures', () => {
    assert.equal(only(view({ rejections: [event('REJECTED', '2026-03-10', 5)] })), undefined);
    assert.equal(kind(only(view({ rejections: [event('REJECTED', '2025-11-10', 5)] }))), 'restriction');
  });

  test('restores once nothing is in default', () => {
    const m = only(view({ levers: levers(otcPaused), owed: [] })) as { kind: string; lever: string };
    assert.deepEqual([m.kind, m.lever], ['restore', 'trading']);
  });

  test('restores a hold when the default ends without a matched payment', () => {
    const m = only(view({ levers: levers(held), owed: [] })) as { kind: string; lever: string };
    assert.deepEqual([m.kind, m.lever], ['restore', 'withdrawals']);
  });

  test('a disputed invoice is not in default', () => {
    const v = view({ disputes: [{ invoiceId: 'INV-1', status: 'under_review', openedOn: '2026-02-05' }] });
    v.invoices[0]!.status = 'disputed';
    assert.equal(only(v), undefined);
  });

  test('skips a client with work in flight', () => {
    assert.equal(only(view({ workItems: [item(9, 'RESTRICTION', 'PROPOSED')] })), undefined);
  });

  test('prepayment only where the contract allows it', () => {
    const apiOnly = { products: ['API'], owed: [['INV-1', 'API', 5_000_000]] as [string, string, number][] };
    assert.equal(restriction(only(view(apiOnly))).step, 'RATE_LIMIT');
    const v = view(apiOnly);
    v.clauses.push({ kind: 'prepay', clause: '9.3', allowed: true, text: '' });
    assert.equal(restriction(only(v)).step, 'REQUIRE_PREPAY');
  });

  test('unapplied cash stops collection and restriction, old cash does not', () => {
    const cash = [wire({ match: 'proposed', valueOn: '2026-03-18' })];
    assert.equal(only(view({ debit: true, usd: 100_000_000, cash })), undefined);
    assert.equal(waited(view({ cash }))?.code, 'payment_unapplied');
    assert.notEqual(only(view({ cash: [wire({ match: 'exception', valueOn: '2025-11-01' })] })), undefined);
  });

  test('an open payment match stops restriction', () => {
    assert.equal(waited(view({ workItems: [item(30, 'PAYMENT_MATCH', 'PROPOSED', {}, { requiredRole: 'ACCOUNTANT' })] }))?.code, 'payment_unapplied');
  });

  test('a restriction set before this agent is described honestly', () => {
    const restricted = levers(active, otcPaused);
    assert.match(waited(view({ levers: restricted, cureDue: '2026-03-15' }))!.reason, /set before this agent/);
    const m = restriction(only(view({ levers: restricted, cureDue: '2026-03-01' })));
    assert.match(m.reasoning, /set before this agent/);
  });

  test('an agreed plan from an earlier default does not apply', () => {
    const c = item(20, 'NOVEL_CASE', 'APPROVED', { onlyLevers: ['withdrawals'], event: 'acquisition' }, { subjectId: 'rm_note:4' });
    assert.equal(restriction(only(view({ workItems: [c], approvals: [event('APPROVED', '2025-10-01', 20, 'NOVEL_CASE')] }))).lever, 'trading');
  });

  test('a material-event approval limits restrictions to withdrawals and is not a grace period', () => {
    const c = item(20, 'NOVEL_CASE', 'APPROVED', { onlyLevers: ['withdrawals'], event: 'acquisition' }, { subjectId: 'rm_note:4' });
    const m = restriction(only(view({ workItems: [c], approvals: [event('APPROVED', '2026-03-18', 20, 'NOVEL_CASE')] })));
    assert.deepEqual([m.lever, m.step], ['withdrawals', 'HOLD_AMOUNT_OWED']);
  });
});

describe('telling the client', () => {
  const posted = item(9, 'RESTRICTION', 'POSTED', { lever: 'trading', step: 'PAUSE_OTC' });
  const l = levers({ ...otcPaused, workItemId: 9 });

  test('after a restriction posts, once', () => {
    const m = notice(only(view({ workItems: [posted], levers: l })));
    assert.match(m.body, /\(ref WI-9\)/);
    assert.match(m.body, /We restore access once the payment posts/);
    const sent = item(10, 'REMINDER', 'POSTED', { body: m.body });
    assert.notEqual(kind(only(view({ workItems: [posted, sent], levers: l }))), 'notice');
  });

  test('no restriction notice once paid: the lever is restored instead', () => {
    const m = only(view({ workItems: [posted], levers: l, owed: [] })) as { kind: string; lever: string };
    assert.deepEqual([m.kind, m.lever], ['restore', 'trading']);
  });

  test('a restore is announced, naming what stays restricted', () => {
    const restore = item(11, 'RESTORE', 'POSTED', { lever: 'api' });
    const left = levers(lever('api', 'active', 'Restored'), lever('withdrawals', 'limited', 'held'));
    const m = notice(only(view({ workItems: [restore], levers: left, owed: [] })));
    assert.match(m.body, /Payment received: your access to the API is restored\. Withdrawals remains restricted until the rest is paid\./);
  });
});

describe('RM notes', () => {
  const n = note();

  test('"already paid" checks the bank feed before anything else', () => {
    const m = notice(only(view({ rmNotes: [n] }), { readings: { 4: PAID } }));
    assert.equal(m.channel, 'rm');
    assert.match(m.body, /No \$50,000\.00 payment from Acme has reached our bank feed/);
    assert.match(m.body, /IMAD123456 not found/);
    assert.match(m.body, /\(re RM-4\)/);
  });

  test('finds a wire in transit', () => {
    const transit = wire({ status: 'pending', match: 'in_transit' });
    const m = notice(only(view({ rmNotes: [n], cash: [transit], inTransit: [transit] }), { readings: { 4: PAID } }));
    assert.match(m.body, /not yet posted/);
  });

  test('proposes the match for unmatched cash, with a reply to fall back on', () => {
    const m = only(view({ rmNotes: [n], cash: [wire({ match: 'exception' })] }), { readings: { 4: PAID } });
    assert.equal(m?.kind, 'payment_match');
    const match = m as Extract<Move, { kind: 'payment_match' }>;
    assert.deepEqual([match.movementId, match.rmNoteId], ['nessie:WI-1', 4]);
    assert.match(match.reply.body, /could not be matched/);
    assert.match(match.after.body, /^We found it: the \$50,000\.00 payment from ACME LP \(WI-1, received 2026-03-02\) pays INV-1\. It is being applied now/);
  });

  test('a returned payment is reported as returned', () => {
    const m = notice(only(view({ rmNotes: [n], cash: [wire({ match: 'reversed' })] }), { readings: { 4: PAID } }));
    assert.match(m.body, /returned by the bank/);
  });

  test('an answered note is not answered again', () => {
    const reply = item(11, 'REMINDER', 'POSTED', { body: 'No payment (re RM-4)' });
    assert.equal(kind(only(view({ rmNotes: [n], workItems: [reply] }), { readings: { 4: PAID } })), 'restriction');
  });

  test('the RM is answered while a proposal waits', () => {
    const m = notice(only(view({ rmNotes: [n], workItems: [item(9, 'RESTRICTION', 'PROPOSED')] }), { readings: { 4: PAID } }));
    assert.equal(m.channel, 'rm');
  });

  test('an RM is pointed at a match already waiting', () => {
    const match = item(40, 'PAYMENT_MATCH', 'PROPOSED', {}, { title: 'Confirm $50,000.00 from ACME LP → INV-1 (Acme)', requiredRole: 'ACCOUNTANT', subjectId: 'nessie:WI-1' });
    const m = notice(only(view({ rmNotes: [n], workItems: [match] }), { readings: { 4: PAID } }));
    assert.match(m.body, /waiting for an accountant to approve \(WI-40\)/);
  });

  test('a waiting match is described from its plan, the movement and the title', () => {
    const cash = wire({ match: 'proposed', ref: 'JD-0042', orig: 'HALVARD GP HOLDINGS', valueOn: '2026-03-18' });
    const plan = { allocations: [{ invoiceId: 'INV-1', amountCents: '14820000' }, { invoiceId: 'INV-2', amountCents: '0' }] };
    const match = item(40, 'PAYMENT_MATCH', 'PROPOSED', { movementId: cash.id, plan }, { subjectId: cash.id, title: 'Confirm $148,200.00 from HALVARD GP HOLDINGS → INV-1, INV-2 (Acme)', requiredRole: 'ACCOUNTANT', amountCents: 14_820_000 });
    const m = notice(only(view({ rmNotes: [n], cash: [cash], workItems: [match] }), { readings: { 4: PAID } }));
    assert.equal(m.body, 'We found it: the $148,200.00 payment from HALVARD GP HOLDINGS (JD-0042, received 2026-03-18) pays INV-1 and INV-2. The match is waiting for an accountant to approve (WI-40); access comes back as soon as it is applied. (re RM-4)');
    const titled = item(40, 'PAYMENT_MATCH', 'PROPOSED', {}, { title: 'Confirm $148,200.00 from HALVARD GP HOLDINGS → INV-1 (Acme)', requiredRole: 'ACCOUNTANT', subjectId: 'nessie:JD-0042' });
    const body = notice(only(view({ rmNotes: [n], workItems: [titled] }), { readings: { 4: PAID } })).body;
    assert.ok(body.startsWith('We found it: the $148,200.00 payment from HALVARD GP HOLDINGS pays INV-1. '), body);
  });

  test('an exception request goes to a controller, never self-approved', () => {
    const m = only(view({ rmNotes: [n] }), { readings: { 4: HOLD_OFF } }) as Extract<Move, { kind: 'case' }>;
    assert.equal(m.kind, 'case');
    assert.deepEqual([m.proposal.kind, m.proposal.subjectId], ['NOVEL_CASE', 'rm_note:4']);
    assert.equal(m.proposal.proposal.graceUntil, '2026-03-31');
  });

  test('an open exception pauses escalation; an approved one grants grace to its date; a rejected one resumes it', () => {
    const open = item(12, 'NOVEL_CASE', 'PROPOSED', {}, { subjectId: 'rm_note:4' });
    assert.equal(only(view({ rmNotes: [n], workItems: [open] }), { readings: { 4: HOLD_OFF } }), undefined);
    const ok = item(12, 'NOVEL_CASE', 'APPROVED', { graceUntil: '2026-03-25' }, { subjectId: 'rm_note:4' });
    const approvals = [event('APPROVED', '2026-03-18', 12, 'NOVEL_CASE')];
    assert.equal(only(view({ rmNotes: [n], workItems: [ok], approvals })), undefined);
    assert.equal(kind(only(view({ rmNotes: [n], workItems: [ok], approvals }), { today: '2026-03-26' })), 'restriction');
    const no = item(12, 'NOVEL_CASE', 'REJECTED', {}, { subjectId: 'rm_note:4' });
    assert.equal(kind(only(view({ rmNotes: [n], workItems: [no], rejections: [event('REJECTED', '2026-03-18', 12, 'NOVEL_CASE', 'broken promises')] }))), 'restriction');
  });

  test('an unparseable grace date falls back to the spacing', () => {
    const c = item(12, 'NOVEL_CASE', 'APPROVED', { graceUntil: 'end of month' }, { subjectId: 'rm_note:4' });
    assert.equal(kind(only(view({ workItems: [c], approvals: [event('APPROVED', '2026-03-01', 12, 'NOVEL_CASE')] }))), 'restriction');
  });

  test('nothing is restricted or collected until the note is read and answered', () => {
    const ready = (extra = {}) => view({ tier: 3, debit: true, usd: 1_000_000, owed: [['INV-1', 'TRADING', 5_000_000]], ...extra });
    const steps = (v: ReturnType<typeof ready>, readings = {}) => ['restriction', 'custody_debit'].includes(only(v, { readings })?.kind ?? '');
    assert.equal(kind(only(ready())), 'restriction', 'control: nobody is looking');
    assert.equal(steps(ready({ rmNotes: [n] })), false);
    assert.equal(waited(ready({ rmNotes: [n] }))?.code, 'rm_note_pending');
    for (const r of [PAID, HOLD_OFF, reading({ intent: 'material_event' })]) assert.equal(steps(ready({ rmNotes: [n] }), { 4: r }), false);
    assert.equal(kind(only(ready({ rmNotes: [n] }), { readings: { 4: reading({ intent: 'other' }) } })), 'restriction', 'an FYI does not pause');
    for (const state of ['PROPOSED', 'NEEDS_INFO']) {
      const c = item(12, 'NOVEL_CASE', state, { graceUntil: '2026-04-01' }, { subjectId: 'rm_note:4' });
      const v = ready({ rmNotes: [n], workItems: [c] });
      assert.equal(steps(v, { 4: HOLD_OFF }), false);
      assert.equal(waited(v, { readings: { 4: HOLD_OFF } })?.code, 'pending_decision');
    }
    for (const proposedBy of ['agent', 'matcher']) {
      const match = item(40, 'PAYMENT_MATCH', 'PROPOSED', { proposedBy }, { requiredRole: 'ACCOUNTANT', subjectId: 'nessie:JD-0001' });
      assert.equal(waited(ready({ workItems: [match] }))?.code, 'payment_unapplied');
    }
  });
});

describe('payment attribution', () => {
  const n = note();
  const unplaced = (...cash: ReturnType<typeof wire>[]) => ({ unplaced: () => cash, readings: { 4: PAID } });

  test('an unplaced wire matching the invoices is proposed, with evidence', () => {
    const m = only(view({ rmNotes: [n] }), unplaced(wire({ match: 'exception', orig: 'ZEPHYR CAPITAL MGMT LP', ref: 'JD-0001' }))) as Extract<Move, { kind: 'payment_match' }>;
    assert.equal(m.kind, 'payment_match');
    assert.deepEqual(m.evidence.signals.map((s) => s.kind), ['rm_says_paid', 'amount_matches_invoices', 'amount_matches_claim']);
    assert.deepEqual([m.evidence.bankRef, m.evidence.invoices], ['JD-0001', ['INV-1']]);
    assert.match(m.reasoning, /RM Priya Nair says Acme paid/);
  });

  test('a wire that does not fit is not proposed', () => {
    const m = only(view({ rmNotes: [n] }), { unplaced: () => [wire({ match: 'exception', amount: 1_234_500 })], readings: { 4: { ...PAID, claimedAmountUsd: null } } });
    assert.match(notice(m).body, /No payment from Acme/);
  });

  test('two equally likely wires are left to a person; a quoted reference breaks the tie', () => {
    const two = [wire({ match: 'exception', ref: 'JD-0001' }), wire({ match: 'exception', ref: 'JD-0002' })];
    assert.equal(kind(only(view({ rmNotes: [n] }), unplaced(...two))), 'notice');
    const tied = [two[0]!, wire({ match: 'exception', ref: 'JD-0002', memo: 'IMAD IMAD123456' })];
    const m = only(view({ rmNotes: [n] }), unplaced(...tied)) as Extract<Move, { kind: 'payment_match' }>;
    assert.deepEqual([m.kind, m.movementId], ['payment_match', 'nessie:JD-0002']);
  });
});

describe('material events', () => {
  const ACQUIRED = reading({ intent: 'material_event', summary: 'being acquired', eventType: 'acquisition', counterparty: 'Meridian Holdings', effectiveDate: '2026-04-15' });
  const policies = [{ policyId: 'pol-006', title: 'Restrict one lever one step at a time', ruleJson: '{}' }];
  const cobalt = (extra = {}) => {
    const v = view({
      products: ['CUSTODY', 'API'], owed: [['INV-1760', 'CUSTODY', 3_820_000], ['INV-1761', 'API', 2_320_000]], cure: 'open', cureDue: '2026-03-14', usd: 18_947_000, rmNotes: [note()], ...extra,
    });
    v.clauses.push({ kind: 'change_of_control', clause: '12.4', allowed: true, text: 'Amounts due become payable at the closing of a change of control.' });
    v.clauses[1]!.allowed = false;
    return v;
  };
  const caseOf = (v: ReturnType<typeof cobalt>, w = {}) => (planFor(v, { policies, readings: { 4: ACQUIRED }, today: '2026-03-03', ...w }).decision as Extract<Move, { kind: 'case' }>).proposal;

  test('an acquisition becomes a novel case with its investigation', () => {
    const p = caseOf(cobalt());
    assert.deepEqual([p.kind, p.subjectId], ['NOVEL_CASE', 'rm_note:4']);
    const steps = p.proposal.investigation as { tool: string; summary: string }[];
    assert.deepEqual(steps.map((s) => s.tool), ['rm_note', 'policy_search', 'contract', 'exposure', 'custody_activity', 'proposal']);
    const by = Object.fromEntries(steps.map((s) => [s.tool, s.summary]));
    assert.match(by.policy_search!, /None of the 1 active policies covers a change of control/);
    assert.match(by.contract!, /§12\.4/);
    assert.match(p.title, /Meridian Holdings/);
    assert.match(p.reasoning, /Invoke §12\.4/);
    assert.match(p.reasoning, /No restriction before the cure period ends 2026-03-14/);
    assert.match(p.reasoning, /hold \$61,400\.00 of withdrawals under §7\.2/);
    assert.match(p.reasoning, /written consent to debit/);
    assert.deepEqual(p.clausesCited, ['12.4', '7.2']);
  });

  test('cash leaving custody is called out', () => {
    const p = caseOf(cobalt({ accessRequests: [{ action: 'withdraw', decision: 'approved', allowedCents: 135_000_000 }], flags: [{ status: 'open', pattern: 'withdrawal_during_cure' }] }));
    const by = Object.fromEntries((p.proposal.investigation as { tool: string; summary: string }[]).map((s) => [s.tool, s.summary]));
    assert.match(by.custody_activity!, /\$1,350,000\.00 withdrawn/);
    assert.match(by.custody_activity!, /withdrawal_during_cure/);
    assert.match(p.reasoning, /secure the balance before closing/);
  });

  test('the approved plan restricts only withdrawals', () => {
    const c = item(20, 'NOVEL_CASE', 'APPROVED', { onlyLevers: ['withdrawals'] }, { subjectId: 'rm_note:4' });
    const v = cobalt({ workItems: [c], approvals: [event('APPROVED', '2026-03-05', 20, 'NOVEL_CASE')] });
    v.deadlines[0]!.status = 'expired';
    const m = restriction(only(v, { today: '2026-03-15' }));
    assert.deepEqual([m.lever, m.step], ['withdrawals', 'HOLD_AMOUNT_OWED']);
    v.levers[0] = lever('withdrawals', 'limited', '$61,400.00 held');
    assert.equal(only(v, { today: '2026-04-01' }), undefined);
  });

  test('the investigation is recorded once', () => {
    const c = item(20, 'NOVEL_CASE', 'PROPOSED', { investigation: [{ tool: 'rm_note', summary: 'x' }] }, { subjectId: 'rm_note:4' });
    const v = cobalt({ workItems: [c] });
    const first = planFor(v, { policies }).bookkeeping[0];
    assert.deepEqual(first, { kind: 'investigation', workItemId: 20, steps: [{ tool: 'rm_note', summary: 'x', status: 'done' }], summary: '1 investigation steps on WI-20' });
    assert.equal(planFor(v, { policies, investigated: new Set([20]) }).bookkeeping.length, 0);
  });
});

describe('why the agent did not act', () => {
  test('each reason to wait is recorded', () => {
    const transit = wire({ status: 'pending', match: 'in_transit', ref: 'WI-5412' });
    const promise = { id: 2, kind: 'promise_to_pay', startedOn: TODAY, dueOn: '2026-03-25', status: 'open', note: 'CFO promised a wire' };
    const restricted = levers(active, otcPaused);
    const cases = {
      cure_period: view({ cure: 'open' }),
      awaiting_default_notice: view({ cure: null }),
      payment_in_transit: view({ cash: [transit], inTransit: [transit] }),
      promise_to_pay: view({ deadlines: [promise] }),
      controller_rejected: view({ rejections: [event('REJECTED', '2026-03-10', 5, 'RESTRICTION', 'Too strict for this tier')] }),
      escalation_spacing: view({ levers: restricted, cureDue: '2026-03-15' }),
      no_further_step: view({ products: ['CUSTODY'], owed: [['INV-1', 'CUSTODY', 10_000]], setOff: false }),
      pending_decision: view({ workItems: [item(9, 'RESTRICTION', 'PROPOSED')] }),
    };
    for (const [code, v] of Object.entries(cases)) assert.equal(waited(v)?.code, code, code);
    assert.match(waited(cases.payment_in_transit)!.reason, /WI-5412/);
    assert.match(waited(cases.promise_to_pay)!.reason, /CFO promised a wire/);
    assert.match(waited(cases.controller_rejected)!.reason, /“Too strict for this tier”/);
    assert.match(waited(cases.escalation_spacing)!.reason, /until 2026-03-22/);
  });

  test('inside the grace period, it explains why nothing was collected', () => {
    const v = view();
    v.invoices[0]!.dueOn = '2026-03-15';
    const w = waited(v)!;
    assert.equal(w.code, 'grace_period');
    assert.match(w.reason, /in default from 2026-03-26/);
    assert.match(w.reason, /consent \(§6\.3\)/);
    const rejected = view({ debit: true, usd: 100_000_000, rejections: [event('REJECTED', '2026-03-17', 6, 'CUSTODY_DEBIT')] });
    rejected.invoices[0]!.dueOn = '2026-03-15';
    assert.match(waited(rejected)!.reason, /A controller rejected collecting from custody on 2026-03-17/);
  });

  test('a failed gateway command is called out', () => {
    const w = waited(view({ workItems: [item(9, 'RESTRICTION', 'APPROVED')] }), { failedCommands: new Map([[9, 'admin API timeout']]) })!;
    assert.equal(w.code, 'gateway_failed');
    assert.match(w.reason, /admin API timeout/);
  });

  test('the same reason is recorded once', () => {
    const v = view({ cure: 'open' });
    const first = planFor(v);
    assert.equal(first.recordWait, true);
    assert.equal(planFor(v, { lastWait: first.wait!.reason }).recordWait, false);
  });

  test('nothing to record for a client who owes nothing', () => {
    assert.equal(waited(view({ owed: [] })), undefined);
    assert.equal(waited(view({ owed: [], workItems: [item(9, 'RESTRICTION', 'PROPOSED')] })), undefined);
  });
});

describe('precedents', () => {
  const rows = (v: ReturnType<typeof view>) => planFor(v).bookkeeping.flatMap((m) => (m.kind === 'precedent' ? [m.row] : []));

  test('a rejection becomes a live precedent', () => {
    const v = view({ workItems: [item(7, 'RESTRICTION', 'REJECTED')], rejections: [event('REJECTED', '2026-03-10', 7, 'RESTRICTION', 'Too strict for this tier')] });
    const [r, ...rest] = rows(v);
    assert.equal(rest.length, 0);
    assert.deepEqual([r!.id, r!.decision, r!.overrideReason, r!.outcome, r!.source], ['PRC-L7', 'Rejected', 'Too strict for this tier', '', 'live']);
  });

  test('approvals and withdrawals are precedents too, with how it ended', () => {
    const v = view({
      owed: [],
      workItems: [item(7, 'RESTRICTION', 'POSTED', { lever: 'withdrawals', step: 'HOLD_AMOUNT_OWED' }), item(8, 'RESTRICTION', 'WITHDRAWN', { lever: 'trading', step: 'PAUSE_OTC' })],
      approvals: [event('APPROVED', '2026-03-10', 7)], withdrawals: [event('WITHDRAWN', '2026-03-12', 8)],
    });
    v.invoices = [invoicePaid({ id: 'INV-1', product: 'TRADING', issuedOn: '2026-01-15', dueOn: '2026-02-01', amountCents: 5_000_000, paidCents: 0, status: 'open' }, '2026-03-14')];
    const by = Object.fromEntries(rows(v).map((r) => [r.id, r]));
    assert.deepEqual([by['PRC-L7']!.decision, by['PRC-L7']!.proposed, by['PRC-L7']!.outcome], ['Approved', 'Hold amount owed (withdrawals, HOLD_AMOUNT_OWED)', 'Paid in 4d']);
    assert.deepEqual([by['PRC-L8']!.decision, by['PRC-L8']!.outcome], ['Withdrawn', 'Paid before the restriction applied (2026-03-14)']);
  });

  test('the situation is short facts as of the decision', () => {
    const v = view({
      usd: 3_500_000, workItems: [item(7, 'RESTRICTION', 'REJECTED', { lever: 'trading', step: 'PAUSE_OTC' })],
      rejections: [event('REJECTED', '2026-03-10', 7, 'RESTRICTION', 'Renewal soon')], positions: [{ status: 'open', hedgeGroup: 'H1', notionalCents: 1 }],
    });
    v.client.renewalOn = '2026-03-22';
    const r = rows(v)[0]!;
    assert.equal(r.situation, 'Late 37 days, $50,000.00 past due (TRADING), coverage 0.7×, renewal in 12 days, tier 3, hedged positions open');
    assert.deepEqual([r.proposed, r.overrideReason], ['Pause OTC trading (trading, PAUSE_OTC)', 'Renewal soon']);
  });

  test('the outcome is filled in once the client cures, and then left alone', () => {
    const existing = { id: 'PRC-L7', clientId: 'ORG-1', workItemId: 7, decidedOn: '2026-03-10', situation: '', proposed: '', decision: 'Rejected', overrideReason: '', outcome: '', policyRef: '', source: 'live' };
    const v = view({ owed: [], workItems: [item(7, 'RESTRICTION', 'REJECTED')], precedents: [existing], rejections: [event('REJECTED', '2026-03-10', 7)] });
    const [r] = rows(v);
    assert.equal(r!.outcome, 'Paid in 10d');
    v.precedents = [{ ...existing, outcome: r!.outcome }];
    assert.equal(rows(v).length, 0);
  });
});

describe('the cutoff comparison', () => {
  const setup = () => {
    const v = view({
      products: ['CUSTODY', 'TRADING', 'API'], usd: 100_000_000,
      positions: [
        { status: 'open', hedgeGroup: 'H1', notionalCents: 4_000_000_000 }, { status: 'open', hedgeGroup: 'H1', notionalCents: -3_800_000_000 },
        { status: 'open', notionalCents: 200_000_000 }, { status: 'closed', notionalCents: 900_000_000 },
      ],
    });
    v.clauses.push({ kind: 'no_forced_close', clause: '11', allowed: true, text: 'The platform will not force-close client positions to recover fees.' });
    v.custody.push({ asset: 'BTC', valueCents: 900_000_000 });
    return v;
  };
  const policies = [{ policyId: 'pol-006', title: '', ruleJson: '' }, { policyId: 'pol-008', title: '', ruleJson: '' }];
  const compare = (v: ReturnType<typeof setup>) => {
    const m = restriction(planFor(v, { policies }).decision);
    return { m, c: (m.boundaries as any[])[0] };
  };

  test('structured side by side', () => {
    const { m, c } = compare(setup());
    assert.equal(c.kind, 'cutoff_comparison');
    assert.deepEqual([c.proposed.step, c.proposed.positionsForceClosed, c.proposed.custodyFrozenCents], ['PAUSE_OTC', 0, 0]);
    const full = c.fullCutoff;
    assert.deepEqual([full.positionsForceClosed, full.hedgesForceClosed, full.notionalCents], [3, 2, 8_000_000_000]);
    assert.equal(full.estimatedUnwindCostCents, 40_000_000);
    assert.equal(full.custodyFrozenCents, 1_000_000_000);
    assert.equal(full.frozenToOwed, 200);
    assert.deepEqual(full.clausesBreached.map((b: { clause: string }) => b.clause), ['11']);
    assert.deepEqual(full.policiesBreached, ['pol-006', 'pol-008']);
    assert.match(m.reasoning, /Compared with a full cutoff: Freezes all/);
    assert.match(full.summary, /§11 \(no forced close\)/);
    assert.deepEqual([c.proposed.approversNeeded, full.approversNeeded], [0, 2]);
  });

  test('a tier one restriction needs a controller; clause numbers come from the contract', () => {
    const v = setup();
    v.client.tier = 1;
    assert.equal(compare(v).c.proposed.approversNeeded, 1);
    v.clauses[v.clauses.length - 1]!.clause = '14.2';
    assert.match(compare(v).c.fullCutoff.summary, /§14\.2 \(no forced close\)/);
  });

  test('a hold shows its share of custody', () => {
    const v = setup();
    v.flags = [{ status: 'open', pattern: 'withdrawal_during_cure' }];
    const { c } = compare(v);
    assert.equal(c.proposed.custodyFrozenCents, 5_000_000);
    assert.match(c.proposed.summary, /Hold \$50,000\.00 of withdrawals \(0\.5% of \$10,000,000\.00 custody\)/);
  });
});

describe('what the agent says on the panel', () => {
  test('a hold names the client, the amount, and what stays open', () => {
    const m = restriction(only(view({ flags: [{ status: 'open', pattern: 'withdrawal_during_cure' }] })));
    assert.equal(m.headline, 'Acme missed its cure date with $50,000 overdue. Holding the overdue amount; trading stays open.');
    assert.equal(m.what, "hold $50,000 of Acme's withdrawals");
  });

  test('a later step says the client is still unpaid', () => {
    const m = restriction(only(view({ levers: levers(active, otcPaused), cureDue: '2026-03-01' })));
    assert.match(m.headline, /^Acme is still unpaid, \$50,000 overdue\. /);
  });
});

describe('a client that exists nowhere in the dataset', () => {
  /** The demo moment: other names, amounts and products, from "paid" to the restore notice. */
  function story(cid: string, name: string, legal: string, lines: [string, string, number][], sender: string, author: string, text: string, tier = 4) {
    const total = lines.reduce((s, [, , a]) => s + a, 0);
    const v = view({
      products: ['CUSTODY', 'API'], owed: lines, tier,
      levers: [lever('withdrawals', 'limited', `${usd(total)} held`), lever('api', 'limited', 'Rate limited to 100 req/s'), lever('trading', 'not_used', ''), lever('financing', 'not_used', '')],
    });
    v.client = { ...v.client, id: cid, name, legalName: legal, relationshipManager: author };
    v.rmNotes = [{ id: 9, author, text }];
    const readings = { 9: byKeywords(text) };
    const incoming = wire({ match: 'exception', amount: total, orig: sender, ref: 'JD-0042', memo: `PMT DET: FEES ${name.toUpperCase()}`, valueOn: '2026-03-18' });
    const w = { readings, unplaced: () => [incoming] };

    const step1 = only(v, w) as Extract<Move, { kind: 'payment_match' }>;
    assert.deepEqual([step1.kind, step1.movementId], ['payment_match', incoming.id]);
    assert.deepEqual([...step1.evidence.invoices].sort(), lines.map(([id]) => id).sort());
    assert.ok(step1.evidence.signals.some((s) => s.kind === 'remittance_names_client'));

    v.workItems = [item(77, 'PAYMENT_MATCH', 'PROPOSED', {}, { title: `Confirm ${usd(total)} from ${sender}`, requiredRole: 'ACCOUNTANT', subjectId: incoming.id })];
    const step2 = notice(only(v, w));
    assert.equal(step2.channel, 'rm');
    assert.match(step2.body, /\(WI-77\)/);
    assert.match(step2.body, /\(re RM-9\)/);

    v.workItems = [item(77, 'PAYMENT_MATCH', 'POSTED', {}, { subjectId: incoming.id }), item(78, 'REMINDER', 'POSTED', { body: step2.body })];
    v.invoices = v.invoices.map((i) => invoicePaid(i, '2026-03-19'));
    v.levers[0] = lever('withdrawals', 'active', 'Hold released · all assets withdrawable');
    const step3 = only(v, { readings, unplaced: () => [] }) as { kind: string; lever: string };
    assert.deepEqual([step3.kind, step3.lever], ['restore', 'api']);

    v.levers[1] = lever('api', 'active', 'Restored');
    v.workItems.push(item(79, 'RESTORE', 'POSTED', { lever: 'api' }));
    assert.match(notice(only(v, { readings, unplaced: () => [] })).body, /Payment received: your access to the API is restored\. Your account is fully back to normal\./);
  }
  const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

  test('Northwind', () => story('ORG-77001', 'Northwind Basis Fund', 'Northwind Basis Fund LP', [['INV-9001', 'API', 1_234_567], ['INV-9002', 'CUSTODY', 800_000]], 'HALVARD GP HOLDINGS', 'Dana Whitlock', "Northwind already paid, $20,345.67 sent by their GP last week. Please don't keep them frozen."));
  test('a different client and amount', () => story('ORG-55120', 'Sable Harbor Treasury', 'Sable Harbor Treasury Inc', [['INV-4410', 'CUSTODY', 321_000], ['INV-4411', 'API', 99_015], ['INV-4412', 'API', 7_700_000]], 'MERIDIAN ESCROW SERVICES', 'Ken Ito', 'They wired it yesterday via escrow, $81,200.15 total.', 2));
});
