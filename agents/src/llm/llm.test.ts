import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askWith, type Provider } from './index';
import { AnswerRejected, DecisionUnavailable } from './errors';

/** A fake provider: scripted outcomes, one per call (an Error is thrown). */
function provider(name: string, outcomes: (string | Error)[]): Provider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name, prompts,
    async answer(prompt) {
      prompts.push(prompt);
      const o = outcomes[Math.min(prompts.length, outcomes.length) - 1]!;
      if (o instanceof Error) throw o;
      return o;
    },
  };
}

const schema = { type: 'object' };
const req = { system: 'sys', prompt: 'ask', schema };

test('the first provider answers and the second is not called', async () => {
  const a = provider('factory', ['{"x":1}']);
  const b = provider('anthropic', ['{"x":2}']);
  assert.deepEqual(await askWith([a, b])(req), { x: 1 });
  assert.equal(b.prompts.length, 0);
  assert.equal(a.prompts[0], 'sys\n\nask');
});

test('a failing provider hands the call to the next', async () => {
  const a = provider('factory', [new DecisionUnavailable('timeout')]);
  const b = provider('anthropic', ['{"x":2}']);
  assert.deepEqual(await askWith([a, b])(req), { x: 2 });
});

test('every provider failing is DecisionUnavailable, naming each', async () => {
  const ask = askWith([provider('factory', [new Error('a')]), provider('anthropic', [new Error('b')])]);
  await assert.rejects(ask(req), (e: Error) => e instanceof DecisionUnavailable && /factory: a; anthropic: b/.test(e.message));
});

test('no providers is DecisionUnavailable', async () => {
  await assert.rejects(askWith([])(req), DecisionUnavailable);
});

test('a code fence around the JSON is fine', async () => {
  assert.deepEqual(await askWith([provider('a', ['```json\n{"x":1}\n```'])])(req), { x: 1 });
});

test('a rejected answer is asked again with the rejection note, and who answered goes to validate', async () => {
  const a = provider('factory', ['{"n":1}', '{"n":2}']);
  const seen: unknown[] = [];
  const validate = ((v: { n: number }, by: unknown) => {
    seen.push(by);
    if (v.n < 2) throw new Error('n must be at least 2');
    return v.n;
  }) as (v: unknown) => number;
  assert.equal(await askWith([a])({ ...req, validate }), 2);
  assert.equal(a.prompts.length, 2);
  assert.match(a.prompts[1]!, /Your previous answer was rejected[\s\S]*n must be at least 2/);
  assert.deepEqual(seen[1], { provider: 'factory', model: 'claude-opus-5-5' });
});

test('not JSON twice, or rejected twice, is AnswerRejected', async () => {
  const notJson = provider('a', ['nope', 'still nope']);
  await assert.rejects(askWith([notJson])(req), AnswerRejected);
  assert.match(notJson.prompts[1]!, /not valid JSON/);
  const never = provider('a', ['{}']);
  await assert.rejects(askWith([never])({ ...req, validate: () => { throw new Error('no'); } }), AnswerRejected);
  assert.equal(never.prompts.length, 2);
});
