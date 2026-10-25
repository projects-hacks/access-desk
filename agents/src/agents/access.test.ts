import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answering, note, only, PAID, view, wire } from '../access/fixtures';
import type { Move } from '../access/model';
import type { Ask, TaskContext } from '../types';
import { execute } from './access';

/** A context whose reducers are recorded; `refuse` names the ones the database turns down. */
function fake(opts: { refuse?: string[]; ask?: Ask } = {}) {
  const calls: { reducer: string; args: any }[] = [];
  const attempts: { what: string; instead?: string; refusal?: string }[] = [];
  const said: string[] = [];
  const reducers = new Proxy({}, {
    get: (_t, reducer: string) => async (args: unknown) => {
      if (opts.refuse?.includes(reducer)) throw new Error(`${reducer} refused`);
      calls.push({ reducer, args });
    },
  });
  const ctx = {
    conn: { reducers }, today: '2026-03-20',
    ask: opts.ask ?? (async () => {
      throw new Error('no model');
    }),
    say: async (text: string) => void said.push(text),
    attempt: async (what: string, call: () => Promise<void>, instead?: string) => {
      try {
        await call();
        attempts.push({ what, instead });
        return undefined;
      } catch (e) {
        const refusal = (e as Error).message;
        attempts.push({ what, instead, refusal });
        return refusal;
      }
    },
  } as unknown as TaskContext;
  return { ctx, calls, attempts, said };
}

const matchMove = () => {
  const v = view({ rmNotes: [note()], cash: [wire({ match: 'exception', ref: 'JD-0042', valueOn: '2026-03-18' })] });
  return { v, move: only(v, { readings: { 4: PAID } }) as Move };
};

test('the RM hears back in the same pass, once the match went through', async () => {
  const { v, move } = matchMove();
  const { ctx, calls } = fake();
  assert.equal(await execute(ctx, v, move), undefined);
  assert.deepEqual(calls.map((c) => c.reducer), ['proposePaymentMatch', 'proposeNotice']);
  assert.equal(calls[0]!.args.rmNoteId, 4n);
  assert.equal(calls[1]!.args.channel, 'rm');
  assert.equal(calls[1]!.args.body, 'We found it: the $50,000.00 payment from ACME LP (JD-0042, received 2026-03-18) pays INV-1. It is being applied now; access comes back as soon as it is. (re RM-4)');
});

test('a refused match is replaced by a reply that an accountant is looking', async () => {
  const { v, move } = matchMove();
  const { ctx, calls, attempts } = fake({ refuse: ['proposePaymentMatch'] });
  assert.equal(await execute(ctx, v, move), 'proposePaymentMatch refused');
  assert.deepEqual(calls.map((c) => c.reducer), ['proposeNotice']);
  assert.match(calls[0]!.args.body, /could not be matched automatically/);
  assert.equal(attempts[0]!.instead, 'tell the RM it is with an accountant');
});

test('a restriction is announced, then proposed; a refusal is returned', async () => {
  const { ctx, calls, said } = fake({ refuse: ['proposeRestrictionWithBoundaries'] });
  const v = view();
  const move = only(v)!;
  assert.match(await execute(ctx, v, move) ?? '', /refused/);
  assert.deepEqual(said, ['Acme missed its cure date with $50,000 overdue. Pause OTC trading.']);
  assert.equal(calls.length, 0);
});

test('a restriction carries its cutoff comparison to the reducer', async () => {
  const { ctx, calls } = fake();
  const v = view();
  await execute(ctx, v, only(v)!);
  const [call] = calls;
  assert.equal(call!.reducer, 'proposeRestrictionWithBoundaries');
  assert.deepEqual([call!.args.lever, call!.args.step, call!.args.policyRef], ['trading', 'PAUSE_OTC', 'pol-006']);
  assert.equal(JSON.parse(call!.args.boundariesJson)[0].kind, 'cutoff_comparison');
});

test('a notice goes out as the template unless the model words it within the facts', async () => {
  const v = view({
    levers: [{ lever: 'trading', state: 'limited', detail: 'OTC paused', workItemId: 9 }],
    workItems: [{ id: 9, kind: 'RESTRICTION', state: 'POSTED', subjectId: 'ORG-1', title: '', requiredRole: 'CONTROLLER', policyRef: 'pol-006', amountCents: 0, proposalJson: JSON.stringify({ lever: 'trading', step: 'PAUSE_OTC' }) }],
  });
  const move = only(v)!;
  const plain = fake();
  await execute(plain.ctx, v, move);
  assert.match(plain.calls[0]!.args.body, /^We have paused OTC trading because \$50,000\.00 is past due \(INV-1\)/);
  assert.equal(plain.calls[0]!.args.reasoning, '- A restriction (WI-9) is live and the client has not been told.\n- The notice says what changed, why and how to restore access.');

  const reworded = fake({ ask: answering({ text: 'Your OTC trading is paused until the $50,000.00 on INV-1 is paid.' }) });
  await execute(reworded.ctx, v, move);
  assert.equal(reworded.calls[0]!.args.body, 'Your OTC trading is paused until the $50,000.00 on INV-1 is paid. (ref WI-9)');
  assert.match(reworded.calls[0]!.args.reasoning, /\n- Worded by Claude\. Every number checked against the facts\.$/);
});
