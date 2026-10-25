import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TODAY, item, lever, note, view, world } from '../access/fixtures';
import { loadFixture } from '../credit/fixture';
import { rulesVerdict } from '../exploit/judge';
import { findingsFor } from '../exploit/scan';
import type { Facts } from './facts';
import { Gate, MAX_REFUSALS, type Actor } from './gate';
import { checkedPhrase, readTools } from './read';
import { rowanTools } from './rowan';
import { ToolServer } from './server';
import { checkNotice, noticeFacts, sageTools } from './sage';
import { plain, plainPoints } from './text';
import { Toolset } from './toolset';

/** An actor whose reducers are recorded; `refuse` names the ones the database turns down. */
function fake(refuse: string[] = []) {
  const calls: { reducer: string; args: any }[] = [];
  const attempts: { what: string; refusal?: string }[] = [];
  const reducers = new Proxy({}, {
    get: (_t, reducer: string) => async (args: unknown) => {
      if (refuse.includes(reducer)) throw new Error(`${reducer} refused`);
      calls.push({ reducer, args });
    },
  });
  const actor = {
    conn: { reducers },
    attempt: async (what: string, call: () => Promise<void>) => {
      try {
        await call();
        attempts.push({ what });
        return undefined;
      } catch (e) {
        attempts.push({ what, refusal: (e as Error).message });
        return (e as Error).message;
      }
    },
  } as unknown as Actor;
  return { actor, calls, attempts };
}

const facts = (v = view(), w = world()): Facts => ({ today: TODAY, view: v, world: w, status: 'active', holds: [], waits: [], applications: [], flags: [], similar: [] });
const sage = (opts: { record?: boolean; refuse?: string[]; facts?: Facts } = {}) => {
  const f = opts.facts ?? facts();
  const gate = new Gate(opts.record);
  const a = fake(opts.refuse);
  return { ...a, gate, f, tools: new Toolset([...readTools(f), ...sageTools(f, a.actor, gate)]) };
};

describe('scoping', () => {
  test('no tool takes a client id, and every write is for the task\'s client', async () => {
    const s = sage();
    for (const d of s.tools.defs) assert.ok(!Object.keys(d.input).some((k) => /client/i.test(k)), d.name);
    await s.tools.call('restrict_lever', { lever: 'trading', reason: 'Trading is unpaid.' });
    assert.ok(s.calls.length === 1 && s.calls.every((c) => c.args.clientId === 'ORG-1'));
  });

  test('read tools show only this client, in dollars and dates', async () => {
    const s = sage();
    const overview = JSON.parse(await s.tools.call('client_overview'));
    assert.equal(overview.name, 'Acme');
    assert.equal(overview.contract.cureDays, 15);
    const inv = JSON.parse(await s.tools.call('invoices'));
    assert.equal(inv.totalOverdue, '$50,000.00');
    assert.deepEqual([inv.overdue[0].id, inv.overdue[0].dueOn, inv.overdue[0].daysLate], ['INV-1', '2026-02-01', 47]);
    assert.equal(await s.tools.call('similar_cases'), 'no similar cases on record');
  });

  test('the server gives each session its own client: wrong or missing token gets nothing', async () => {
    const server = new ToolServer();
    const a = sage();
    const b = sage({ facts: facts(view({ client: { id: 'ORG-2', name: 'Bravo', legalName: 'Bravo LP', tier: 3, strategic: false, relationshipManager: 'X' } })) });
    const [ba, bb] = [await server.bind(a.tools), await server.bind(b.tools)];
    const connect = async (binding: typeof ba) => {
      const client = new Client({ name: 't', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(binding.config.url), { requestInit: { headers: Object.fromEntries(binding.config.headers.map((h) => [h.name, h.value])) } }));
      return client;
    };
    try {
      const ca = await connect(ba);
      const cb = await connect(bb);
      const name = async (c: Client) => JSON.parse(((await c.callTool({ name: 'client_overview', arguments: {} })) as any).content[0].text).name;
      assert.deepEqual([await name(ca), await name(cb)], ['Acme', 'Bravo']);
      assert.equal((await ca.listTools()).tools.length, a.tools.defs.length);
      await ca.close();
      await cb.close();
      const res = await fetch(ba.config.url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer nope' }, body: '{}' });
      assert.equal(res.status, 401);
      assert.equal((await fetch(ba.config.url, { method: 'POST', body: '{}' })).status, 401);
      ba.release();
      assert.equal((await fetch(ba.config.url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: ba.config.headers[0]!.value }, body: '{}' })).status, 401);
    } finally {
      await server.close();
    }
  });
});

describe('one action per task', () => {
  test('after one success, every other action says so and writes nothing', async () => {
    const s = sage();
    assert.match(await s.tools.call('restrict_lever', { lever: 'trading', reason: 'Trading is unpaid.' }), /^done: proposed to pause OTC trading for Acme/);
    for (const [tool, args] of [['hold_off', { code: 'other', reason: 'Wait a bit.' }], ['hold_amount_owed', { reason: 'Hold it.' }], ['restore_lever', { lever: 'trading', reason: 'Paid.' }]] as const) {
      assert.match(await s.tools.call(tool, args), /^already acted this task/);
    }
    assert.deepEqual(s.calls.map((c) => c.reducer), ['proposeRestrictionWithBoundaries']);
    assert.equal(JSON.parse(s.calls[0]!.args.boundariesJson)[0].kind, 'cutoff_comparison');
    assert.match(await s.tools.call('invoices'), /totalOverdue/); // reads stay open
  });

  test('a refusal comes back as text, is not the one action, and the agent can adapt', async () => {
    const s = sage({ refuse: ['proposeRestrictionWithBoundaries'] });
    const r = await s.tools.call('restrict_lever', { lever: 'trading', reason: 'Trading is unpaid.' });
    assert.equal(r, 'refused: proposeRestrictionWithBoundaries refused');
    assert.equal(s.attempts[0]!.refusal, 'proposeRestrictionWithBoundaries refused');
    assert.match(await s.tools.call('hold_off', { code: 'cure_period', reason: 'The cure period runs.' }), /^done:/);
    assert.deepEqual(s.calls.map((c) => [c.reducer, c.args.code]), [['recordWait', 'cure_period']]);
  });

  test('too many refusals and the agent is told to stop', async () => {
    const s = sage({ refuse: ['proposeRestore'] });
    for (let i = 0; i < MAX_REFUSALS; i++) await s.tools.call('restore_lever', { lever: 'api', reason: 'Paid up now.' });
    assert.match(await s.tools.call('restore_lever', { lever: 'api', reason: 'Paid up now.' }), /refused too many times/);
  });

  test('a lever with no further step is refused by the tool itself, before the database', async () => {
    const s = sage({ facts: facts(view({ products: ['TRADING'], owed: [['INV-1', 'TRADING', 5_000_000]], levers: [lever('trading', 'limited', 'No new positions · closing allowed')], workItems: [item(3, 'RESTRICTION', 'POSTED', { step: 'CLOSE_ONLY' })] })) });
    assert.match(await s.tools.call('restrict_lever', { lever: 'api', reason: 'Not in contract.' }), /^refused: no further step on api/);
    assert.equal(s.calls.length, 0);
  });
});

describe('shadow mode', () => {
  test('actions are recorded and nothing is written', async () => {
    const s = sage({ record: true });
    assert.equal(await s.tools.call('hold_amount_owed', { reason: 'Hold the amount owed.' }), 'recorded (shadow)');
    assert.match(await s.tools.call('collect_overdue_from_custody', { reason: 'Collect.' }), /^already acted/);
    assert.equal(s.calls.length, 0);
    assert.equal(s.attempts.length, 0);
    assert.deepEqual(s.gate.outcomes.map((o) => o.tool), ['hold_amount_owed']);
    assert.match(await s.tools.call('payments'), /wireInstructions/); // reads still work
  });
});

describe('notices follow the notice rules', () => {
  const v = view({ rmNotes: [note(4)], workItems: [item(9, 'RESTRICTION', 'POSTED', { lever: 'trading', step: 'PAUSE_OTC' })] });
  const ok = 'Your OTC trading is paused until the $50,000.00 on INV-1 is paid.';

  test('numbers must come from the facts', async () => {
    const s = sage({ facts: facts(v) });
    assert.match(await s.tools.call('send_notice', { channel: 'email', text: ok.replace('$50,000.00', '$50,000'), about_work_item: 9, reason: 'Tell the client.' }), /^refused: numbers not in the facts: \$50,000/);
    assert.match(await s.tools.call('send_notice', { channel: 'email', text: `${ok} Pay by 2026-04-01.`, about_work_item: 9, reason: 'Tell the client.' }), /2026-04-01/);
    assert.equal(s.calls.length, 0);
  });

  test('the reference tag is added so the desk knows who was told; a made-up work item is refused', async () => {
    const s = sage({ facts: facts(v) });
    assert.match(await s.tools.call('send_notice', { channel: 'email', text: ok, about_work_item: 77, reason: 'Tell the client.' }), /no work item 77/);
    assert.match(await s.tools.call('send_notice', { channel: 'email', text: ok, about_work_item: 9, reason: 'Tell the client; it is posted — now.' }), /^done/);
    assert.equal(s.calls[0]!.args.body, `${ok} (ref WI-9)`);
    assert.equal(s.calls[0]!.args.reasoning, '- Tell the client.\n- It is posted, now.');
    assert.equal(s.calls[0]!.args.policyRef, 'pol-007');
  });

  test('an RM reply is tagged to the note, and the rules\' own amounts must stay when it answers the same subject', () => {
    const allowed = noticeFacts(facts(v));
    assert.equal(checkNotice('We see $50,000.00 on INV-1.', allowed, 'We see $50,000.00 on INV-1.'), undefined);
    assert.match(checkNotice('We see the payment.', allowed, 'We see $50,000.00 on INV-1.')!, /dropped from the facts/);
    assert.match(checkNotice('word '.repeat(130), allowed)!, /at most 120 words/);
    assert.match(checkNotice('Dear [client], hello.', allowed)!, /placeholders/);
  });
});

describe('Rowan', () => {
  const book = loadFixture().find((b) => b.client.id === 'ORG-90677')!;
  const rows = { client: [], invoice: [], application: [], movement: [], hold: [], workItem: [] };
  const findings = findingsFor(book, rows, book.today);
  const f = (): Facts => ({
    ...facts(),
    exploit: {
      book, findings, checks: [], verdicts: new Map(findings.map((g) => [g.id, rulesVerdict(g)])), stored: new Map(),
      scanInput: { book, rows, raisedSubjects: new Set(), clearedFlags: new Set(), today: book.today },
    },
  });
  const rowan = (record = false) => {
    const a = fake();
    const gate = new Gate(record, true);
    return { ...a, gate, tools: new Toolset(rowanTools(f(), a.actor, gate)) };
  };
  const id = 'restriction_eve:ORG-90677';

  test('an alert writes the flag and the work item the rules write, once per finding', async () => {
    const r = rowan();
    assert.match(await r.tools.call('flag_pattern', { finding_id: id, label: 'alert', reason: 'Pays on the same day after due, every month.' }), /^done: flagged as flagged and raised an alert/);
    assert.deepEqual(r.calls.map((c) => c.reducer), ['upsertExploitFlag', 'proposeWorkItem']);
    assert.equal(r.calls[1]!.args.kind, 'EXPLOIT_FLAG');
    assert.equal(r.calls[1]!.args.subjectId, `exploit:${id}`);
    assert.match(r.calls[1]!.args.reasoning, /Review: Pays on the same day/);
    assert.match(await r.tools.call('flag_pattern', { finding_id: id, label: 'alert', reason: 'Again, same thing.' }), /already flagged/);
    assert.equal(r.calls.length, 2);
  });

  test('watch writes the flag only; an unknown id is refused; shadow writes nothing', async () => {
    const r = rowan();
    assert.match(await r.tools.call('flag_pattern', { finding_id: id, label: 'watch', reason: 'Keep an eye on it.' }), /flagged as watch\.$/);
    assert.deepEqual(r.calls.map((c) => c.reducer), ['upsertExploitFlag']);
    assert.match(await r.tools.call('flag_pattern', { finding_id: 'nope', label: 'alert', reason: 'Not a finding.' }), /^refused: no finding with that id/);
    const s = rowan(true);
    assert.equal(await s.tools.call('flag_pattern', { finding_id: id, label: 'alert', reason: 'Pays on the same day.' }), 'recorded (shadow)');
    assert.equal(s.calls.length, 0);
  });
});

describe('words', () => {
  test('plain text has no em dashes or semicolons', () => assert.equal(plain('Late — again; pay now'), 'Late, again. Pay now'));
  test('a reason becomes points, whether the agent wrote lines or a paragraph', () => {
    assert.equal(plainPoints('- $90,000 overdue on 9 invoices.\n- The cure period ended Dec 30 — unpaid.'), '- $90,000 overdue on 9 invoices.\n- The cure period ended Dec 30, unpaid.');
    assert.equal(plainPoints('Nothing is overdue. The client paid on Mar 3; thanks.'), '- Nothing is overdue.\n- The client paid on Mar 3.\n- Thanks.');
  });
  test('the panel says what was checked', () => {
    assert.equal(checkedPhrase(['client_overview', 'payments', 'payments', 'invoices']), 'Checked contract, holds, payments and invoices.');
    assert.equal(checkedPhrase(['hold_off']), '');
  });
});
