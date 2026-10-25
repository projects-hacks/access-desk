import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lowConfidence, needsHuman, type AutonomyInput } from './autonomy';

const review = (over: Partial<AutonomyInput> = {}, proposal: object = { action: 'tier_change', to_tier: 4 }): AutonomyInput => ({
  kind: 'CREDIT_REVIEW', tier: 3, strategic: false, confidence: 0.8, proposal, ...over,
});

test('tier changes and reviews apply on their own below Tier 1, whatever the move', () => {
  assert.equal(needsHuman(review()), undefined);
  for (const tier of [2, 3, 4, 5]) {
    assert.equal(needsHuman(review({ tier }, { action: 'tier_change', to_tier: 5 })), undefined);
    assert.equal(needsHuman(review({ tier }, { action: 'tier_change', to_tier: 2 })), undefined);
  }
  assert.equal(needsHuman(review({}, { action: 'review' })), undefined);
});

test('a promotion into Tier 1 waits for a person', () => {
  for (const tier of [2, 3, 4, 5]) {
    assert.equal(needsHuman(review({ tier, confidence: 0.99 }, { action: 'tier_change', to_tier: 1 })), 'promotion to tier 1');
  }
});

test('the model going beyond the rules applies on its own only at 0.7 or more', () => {
  const model = (confidence: number, baseline: object) =>
    review({ confidence }, { action: 'tier_change', to_tier: 4, decided_by: 'claude', baseline });
  // The rules would keep the tier; the model moves it.
  assert.match(needsHuman(model(0.69, { action: 'stay', to_tier: 3 })) ?? '', /beyond the rules at confidence 0.69/);
  assert.equal(needsHuman(model(0.7, { action: 'stay', to_tier: 3 })), undefined);
  // The rules would move it elsewhere.
  assert.match(needsHuman(model(0.5, { action: 'tier_change', to_tier: 5 })) ?? '', /beyond the rules/);
  // The model agrees with the rules: no extra bar.
  assert.equal(needsHuman(model(0.3, { action: 'tier_change', to_tier: 4 })), undefined);
  // The rules deciding alone are never held to it.
  assert.equal(needsHuman(review({ confidence: 0.3 }, { action: 'tier_change', to_tier: 4, decided_by: 'rules', baseline: { action: 'stay' } })), undefined);
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
});

test('an unreadable tier is never applied', () => {
  assert.match(needsHuman(review({}, { action: 'tier_change', to_tier: 9 })) ?? '', /unreadable/);
});

test('a client policy that changes the contract or moves money always waits for a person', () => {
  const draft = (levers: string[], over: Partial<AutonomyInput> = {}): AutonomyInput => ({
    kind: 'POLICY_DRAFT', tier: 4, strategic: false, confidence: 0.95, proposal: { rule: { terms: levers.map((lever) => ({ lever })) } }, ...over,
  });
  assert.match(needsHuman(draft(['prepay'])) ?? '', /contract or moves money/);
  assert.match(needsHuman(draft(['reminder', 'cure_days'], { tier: 5, confidence: 1 })) ?? '', /contract or moves money/);
  assert.match(needsHuman(draft([])) ?? '', /contract or moves money/);
});

test('a client policy that only adds reminders is within the desk\'s authority and applies on its own', () => {
  const reminders: AutonomyInput = { kind: 'POLICY_DRAFT', tier: 4, strategic: false, confidence: 0.95, proposal: { rule: { terms: [{ lever: 'reminder' }] } } };
  assert.equal(needsHuman(reminders), undefined);
  // Reminders need no approval for any client (pol-007), top clients included.
  assert.equal(needsHuman({ ...reminders, tier: 1 }), undefined);
});

test('exploit alerts are acknowledged automatically, for any client, whatever the confidence', () => {
  const flag = (over: Partial<AutonomyInput> = {}): AutonomyInput => ({ kind: 'EXPLOIT_FLAG', tier: 4, strategic: false, confidence: 0.03, proposal: {}, ...over });
  assert.equal(needsHuman(flag()), undefined);
  assert.equal(needsHuman(flag({ tier: 1, strategic: true })), undefined);
});
