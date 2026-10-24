import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lowConfidence, needsHuman, type AutonomyInput } from './autonomy';

const review = (over: Partial<AutonomyInput> = {}, proposal: object = { action: 'tier_change', to_tier: 4 }): AutonomyInput => ({
  kind: 'CREDIT_REVIEW', tier: 3, strategic: false, confidence: 0.8, proposal, ...over,
});

test('tier changes and reviews apply on their own, at any tier, whatever the move', () => {
  assert.equal(needsHuman(review()), undefined);
  for (const tier of [2, 3, 4, 5]) {
    assert.equal(needsHuman(review({ tier }, { action: 'tier_change', to_tier: 5 })), undefined);
    assert.equal(needsHuman(review({ tier }, { action: 'tier_change', to_tier: 1 })), undefined);
  }
  assert.equal(needsHuman(review({}, { action: 'review' })), undefined);
});

test('below the confidence threshold any proposal goes to a person, except exploit alerts', () => {
  assert.match(needsHuman(review({ confidence: 0.09 })) ?? '', /confidence 0.09 is below 0.1/);
  assert.equal(needsHuman(review({ confidence: 0.1 })), undefined);
  assert.equal(needsHuman(review({ confidence: 0.3 })), undefined);
  assert.ok(lowConfidence(0.05));
});

test('top clients (Tier 1 or strategic) always go to a controller', () => {
  assert.equal(needsHuman(review({ strategic: true })), 'strategic client');
  assert.equal(needsHuman(review({ tier: 1 })), 'tier 1 client');
  assert.equal(needsHuman({ kind: 'EXPLOIT_FLAG', tier: 1, strategic: true, confidence: 0.9, proposal: {} }), 'strategic client');
});

test('an unreadable tier is never applied', () => {
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
  assert.match(needsHuman(draft(['reminder'], { confidence: 0.05 })) ?? '', /confidence/);
});

test('exploit alerts on everyone but top clients are acknowledged automatically, whatever the confidence', () => {
  const flag = (over: Partial<AutonomyInput> = {}): AutonomyInput => ({ kind: 'EXPLOIT_FLAG', tier: 4, strategic: false, confidence: 0.3, proposal: {}, ...over });
  assert.equal(needsHuman(flag()), undefined);
  assert.equal(needsHuman(flag({ tier: 2 })), undefined);
  assert.equal(needsHuman(flag({ strategic: true })), 'strategic client');
});
