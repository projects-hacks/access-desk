import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ask } from '../types';
import { answering } from './fixtures';
import { byKeywords, readNote } from './pushback';

test('a payment claim, with its amount and reference', () => {
  const r = byKeywords("Don't freeze Kestrel, wire sent yesterday for $148,200, IMAD 20260302MMQFMP2K009911");
  assert.equal(r.intent, 'already_paid');
  assert.equal(r.claimedAmountUsd, 148_200);
  assert.equal(r.paymentReference, '20260302MMQFMP2K009911');
});

test('an exception request, with its date', () => {
  const r = byKeywords('Please hold off on Juniper until 2026-03-20, their new CFO is sorting out payables');
  assert.deepEqual([r.intent, r.graceUntil], ['exception_request', '2026-03-20']);
});

test('an acquisition outranks "hold off"', () => {
  const r = byKeywords('Cobalt is being acquired by Meridian Holdings, closing 2026-04-15. Please hold off until then.');
  assert.deepEqual([r.intent, r.eventType, r.counterparty, r.effectiveDate, r.graceUntil], ['material_event', 'acquisition', 'Meridian Holdings', '2026-04-15', null]);
});

test('anything else asks for nothing', () => {
  assert.equal(byKeywords('FYI their CFO changed last week.').intent, 'other');
});


test('the model reads the note, and who read it is kept', async () => {
  const answer = { intent: 'material_event', summary: 'being acquired', claimed_amount_usd: null, payment_reference: null, grace_until: null, reason: null, event_type: 'acquisition', counterparty: 'Meridian Holdings', effective_date: '2026-04-15' };
  const r = await readNote(answering(answer), 'Cobalt is being bought by Meridian', 'Cobalt', '2026-03-03');
  assert.deepEqual([r.intent, r.eventType, r.counterparty, r.readBy], ['material_event', 'acquisition', 'Meridian Holdings', 'anthropic']);
});

test('no answer, or an unusable one, falls back to keywords', async () => {
  const none: Ask = async () => {
    throw new Error('no model');
  };
  assert.equal((await readNote(none, 'wire sent for $5,000', 'Acme', '2026-03-03')).readBy, 'keywords');
  const r = await readNote(answering({ intent: 'whatever' }), 'wire sent for $5,000', 'Acme', '2026-03-03').catch((e) => e);
  assert.ok(r instanceof Error || r.readBy === 'keywords');
});
