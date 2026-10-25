import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDataset } from '../dataset';
import { isBalanced } from '../dataset/gl';
import type { DbConnection } from '../module_bindings';
import { invoiceRow } from '../sync/sources/platform';
import { openPlatform } from './bootstrap';
import { PlatformError, PlatformSimulator } from './simulator';
import { invoiceKey, invoicesToIssue } from '../world/billing';

const ds = loadDataset();
const issued = invoicesToIssue(ds, '2026-04-01', { ids: ds.invoices.map((i) => i.id), keys: new Set(ds.invoices.map((i) => invoiceKey(i.clientId, i.product, i.period))) });
const target = issued[0]!;
const owed = (sim: PlatformSimulator) => [...sim.invoices.values()].reduce((s, i) => s + i.amountCents - i.paidCents, 0);
/** Receivables in the ledger: debits less credits on 1200. */
const receivables = (sim: PlatformSimulator) => [...sim.journals.values()].flatMap((j) => j.lines).filter((l) => l.account === '1200').reduce((s, l) => s + l.debitCents - l.creditCents, 0);

const open = (sim: PlatformSimulator, id = 'DSP-W0001', invoiceId = target.id, amountCents = target.amountCents) =>
  sim.openDispute({ id, invoiceId, amountCents, reason: 'Volume tier discount not applied', openedOn: '2026-04-10', owner: 'Marcus Okafor' });

test('a dispute marks the invoice disputed; one at a time; not a paid one', () => {
  const sim = new PlatformSimulator(ds);
  sim.issue(issued);
  const d = open(sim);
  assert.deepEqual([d.status, d.clientId, d.resolution], ['under_review', target.clientId, '']);
  assert.equal(sim.invoices.get(target.id)!.status, 'disputed');
  assert.throws(() => open(sim, 'DSP-W0002'), PlatformError);
  const paid = issued[1]!;
  sim.invoices.get(paid.id)!.paidCents = paid.amountCents;
  assert.throws(() => open(sim, 'DSP-W0003', paid.id, paid.amountCents), PlatformError);
});

test('upheld as billed: the invoice reopens unchanged and the books do not move', () => {
  const sim = new PlatformSimulator(ds);
  sim.issue(issued);
  open(sim);
  const before = receivables(sim);
  const d = sim.resolveDispute('DSP-W0001', 'no_change', '2026-05-01');
  assert.deepEqual([d.status, d.resolution, d.resolvedOn], ['resolved', 'no_change', '2026-05-01']);
  assert.deepEqual([sim.invoices.get(target.id)!.status, sim.invoices.get(target.id)!.amountCents], ['open', target.amountCents]);
  assert.equal(receivables(sim), before);
  assert.deepEqual(sim.resolveDispute('DSP-W0001', 'credited', '2026-05-02', 1), d); // ruled once
});

test('credited: a credit note shrinks the invoice and the ledger by the same amount, and the dispute records what was credited', () => {
  const sim = new PlatformSimulator(ds);
  sim.issue(issued);
  open(sim);
  const gap = receivables(sim) - owed(sim); // what the ledger holds beyond the invoices (history), constant while only credit notes move
  const credit = Math.round(target.amountCents * 0.4 / 1000) * 1000;
  const d = sim.resolveDispute('DSP-W0001', 'credited', '2026-05-01', credit);
  assert.equal(d.amountCents, credit);
  assert.equal(sim.invoices.get(target.id)!.amountCents, target.amountCents - credit);
  assert.equal(sim.invoices.get(target.id)!.status, 'open');
  const note = sim.journals.get('JE-CN-DSP-W0001')!;
  assert.ok(isBalanced(note) && note.source === 'billing' && note.postedOn === '2026-05-01');
  assert.equal(receivables(sim) - owed(sim), gap); // ledger and invoices moved together
  assert.throws(() => { const s2 = new PlatformSimulator(ds); s2.issue(issued); open(s2); s2.resolveDispute('DSP-W0001', 'credited', '2026-05-01', target.amountCents + 1); }, PlatformError);
});

test('the dataset\'s own live dispute can be ruled on too, and the synced row follows the platform', () => {
  const sim = new PlatformSimulator(ds);
  const live = [...sim.disputes.values()].find((d) => d.status === 'under_review')!;
  assert.ok(live);
  sim.resolveDispute(live.id, 'no_change', '2026-04-03');
  assert.notEqual(sim.invoices.get(live.invoiceId)!.status, 'disputed');
  sim.reset();
  assert.equal(sim.disputes.get(live.id)!.status, 'under_review');
  assert.equal(sim.invoices.get(live.invoiceId)!.status, 'disputed');
});

test('after a restart the platform is rebuilt from the database: credited invoices at their original amount, then credited again', async () => {
  const before = new PlatformSimulator(ds);
  before.issue(issued);
  const other = issued[5]!;
  open(before);
  open(before, 'DSP-W0002', other.id, other.amountCents);
  const credit = Math.round(target.amountCents * 0.3 / 1000) * 1000;
  before.resolveDispute('DSP-W0001', 'credited', '2026-05-01', credit);
  const story = [...before.disputes.values()].find((d) => d.status === 'under_review' && !d.id.startsWith('DSP-W'))!;
  before.resolveDispute(story.id, 'credited', '2026-05-02', Math.round(story.amountCents / 2000) * 1000);

  // What the golden copy holds: invoices as billing now shows them, disputes as ruled.
  const rows = {
    invoice: [...before.invoices.values()].filter((i) => i.issuedOn >= '2026-04-01' || i.id === story.invoiceId).map(invoiceRow),
    dispute: [...before.disputes.values()].map((d) => ({ ...d, amountCents: BigInt(d.amountCents) })),
  };
  const conn = {
    db: {
      gatewayCommand: { iter: () => [][Symbol.iterator]() },
      invoice: { iter: () => rows.invoice[Symbol.iterator]() },
      dispute: { iter: () => rows.dispute[Symbol.iterator]() },
    },
    subscriptionBuilder: () => ({ onApplied: (cb: () => void) => ({ subscribe: () => cb() }) }),
  } as unknown as DbConnection;
  const after = await openPlatform(conn, ds);

  for (const id of [target.id, other.id, story.invoiceId]) assert.equal(after.invoices.get(id)!.amountCents, before.invoices.get(id)!.amountCents, id);
  assert.equal(after.invoices.get(other.id)!.status, 'disputed');
  assert.equal(after.invoices.get(target.id)!.amountCents, target.amountCents - credit);
  for (const id of ['JE-CN-DSP-W0001', `JE-CN-${story.id}`, `JE-INV-${target.id}`]) assert.deepEqual(after.journals.get(id), before.journals.get(id), id);
  assert.equal(receivables(after), receivables(before));
  assert.equal(after.disputes.get('DSP-W0002')!.status, 'under_review');
});
