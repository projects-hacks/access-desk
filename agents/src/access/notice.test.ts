import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Ask } from '../types';
import { answering } from './fixtures';
import { safe, wordNotice } from './notice';

const DRAFT = 'We have placed a hold on withdrawals equal to the amount past due because $148,200.00 is past due '
  + '(INV-1747, INV-1748, INV-1749). To restore access, pay the amount past due: Northstar Prime Ltd · '
  + 'ACCT 8262801103717637 · reference your client id. We restore access once the payment posts. (ref WI-12)';
const GOOD = "Because $148,200.00 is past due on INV-1747, INV-1748 and INV-1749, we've held that amount of your "
  + 'withdrawals. Everything else on your account works as usual. Paying to Northstar Prime Ltd · ACCT '
  + '8262801103717637 (quote your client id) lifts the hold once the payment posts.';

describe('the number check', () => {
  test('a faithful rewrite passes', () => assert.equal(safe(DRAFT, GOOD), undefined));
  test('an invented amount fails', () => assert.match(safe(DRAFT, GOOD.replace('$148,200.00', '$150,000.00'))!, /\$150,000\.00/));
  test('a new date fails', () => assert.match(safe(DRAFT, `${GOOD} Please pay by 2026-03-20.`)!, /2026-03-20/));
  test('a dropped invoice fails', () => assert.match(safe(DRAFT, GOOD.replace(' and INV-1749', ''))!, /INV-1749/));
  test('a dropped amount fails', () => assert.match(safe(DRAFT, GOOD.replace('$148,200.00', 'the amount'))!, /\$148,200\.00/));
  test('a reformatted amount fails', () => assert.notEqual(safe(DRAFT, GOOD.replace('$148,200.00', '$148.2k')), undefined));
});

const answerText = (text: string, provider = 'factory') => answering({ text }, provider);

describe('wording', () => {
  test('the model words it, who did is named, and the tag is kept', async () => {
    const r = await wordNotice(answerText(GOOD), 'email', DRAFT, 'Client: Kestrel Quant');
    assert.deepEqual(r, { text: `${GOOD} (ref WI-12)`, by: 'factory' });
  });

  test('wording that fails the number check sends the template', async () => {
    const r = await wordNotice(answerText(GOOD.replace('$148,200.00', '$148,000.00')), 'email', DRAFT, '');
    assert.deepEqual(r, { text: DRAFT, by: '' });
  });

  test('no answer sends the template', async () => {
    const none: Ask = async () => {
      throw new Error('no model');
    };
    assert.deepEqual(await wordNotice(none, 'rm', DRAFT, ''), { text: DRAFT, by: '' });
  });

  test('the draft the model sees has no tag', async () => {
    let seen = '';
    const spy: Ask = async ({ prompt }) => {
      seen = prompt;
      throw new Error('stop');
    };
    await wordNotice(spy, 'email', DRAFT, '');
    assert.ok(!seen.includes('(ref WI-12)'));
    assert.match(seen, /Audience: the client's finance team, by email/);
  });
});
