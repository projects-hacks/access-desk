import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsHuman, type AutonomyInput } from './autonomy';

const review = (over: Partial<AutonomyInput> = {}, proposal: object = { action: 'tier_change', to_tier: 4 }): AutonomyInput => ({
  kind: 'CREDIT_REVIEW', tier: 3, strategic: false, confidence: 0.8, proposal, ...over,
});

test('a regular tier 3 downgrade to tier 4 applies on its own', () => {
  assert.equal(needsHuman(review()), undefined);
  assert.equal(needsHuman(review({ tier: 4 }, { action: 'tier_change', to_tier: 3 })), undefined);
});

test('tier 1 and 2 clients always go to a controller, whatever the proposal', () => {
  for (const tier of [1, 2]) {
    assert.match(needsHuman(review({ tier }, { action: 'tier_change', to_tier: 3 })) ?? '', /client/);
    assert.ok(needsHuman({ kind: 'POLICY_DRAFT', tier, strategic: false, confidence: 0.9, proposal: { rule: { terms: [{ lever: 'reminder' }] } } }));
    assert.ok(needsHuman({ kind: 'EXPLOIT_FLAG', tier, strategic: false, confidence: 0.9, proposal: {} }));
  }
});

test('strategic clients always go to a controller, even at tier 3', () => {
  assert.equal(needsHuman(review({ strategic: true })), 'strategic client');
});

test('the worst cases still need a person', () => {
  assert.match(needsHuman(review({}, { action: 'review' })) ?? '', /review/);
  assert.match(needsHuman(review({ tier: 4 }, { action: 'tier_change', to_tier: 5 })) ?? '', /tier 5/);
  assert.match(needsHuman(review({}, { action: 'tier_change', to_tier: 2 })) ?? '', /tier 2/);
  assert.match(needsHuman(review({ confidence: 0.5 })) ?? '', /confidence/);
  assert.match(needsHuman(review({}, { action: 'tier_change', to_tier: 9 })) ?? '', /unreadable/);
});

test('company policies: reminders and prepay apply, custody debit and cross-default do not', () => {
  const draft = (levers: string[], over: Partial<AutonomyInput> = {}): AutonomyInput => ({
    kind: 'POLICY_DRAFT', tier: 4, strategic: false, confidence: 0.8,
    proposal: { rule: { terms: levers.map((lever) => ({ lever })) } }, ...over,
  });
  assert.equal(needsHuman(draft(['prepay', 'reminder'])), undefined);
  assert.match(needsHuman(draft(['reminder', 'custody_debit'])) ?? '', /custody debit/);
  assert.match(needsHuman(draft(['cross_default'])) ?? '', /cross default/);
  assert.match(needsHuman(draft(['reminder'], { confidence: 0.4 })) ?? '', /confidence/);
});

test('exploit alerts on tier 3 to 5 clients are acknowledged automatically, whatever the confidence', () => {
  const flag = (over: Partial<AutonomyInput> = {}): AutonomyInput => ({ kind: 'EXPLOIT_FLAG', tier: 4, strategic: false, confidence: 0.3, proposal: {}, ...over });
  assert.equal(needsHuman(flag()), undefined);
  assert.equal(needsHuman(flag({ strategic: true })), 'strategic client');
});
