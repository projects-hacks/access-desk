import { SenderError, t } from 'spacetimedb/server';
import { BOOKS, stepChecks } from '../agents';
import { runTieOut } from '../books/tieout';
import { requireRole, simDate, type Ctx } from '../context';
import { createWorkItem } from '../payments/apply';
import { GL, queueJournal } from '../payments/gateway';

import { spacetimedb } from '../schema';

/** Reconcile now. Sync calls this after each pass; a controller can run it any time. */
export const tieOut = spacetimedb.reducer({ trigger: t.string() }, (ctx, { trigger }) => {
  requireRole(ctx, ['SYNC', 'GATEWAY', 'CONTROLLER', 'ADMIN']);
  runTieOut(ctx, trigger);
});

const Line = t.object('AdjustingLine', { account: t.string(), debitCents: t.i64(), creditCents: t.i64() });
type AdjustingLine = { account: string; debitCents: bigint; creditCents: bigint };

/** Accounts an adjusting entry may touch, and the tie-out area each one is checked in. Never cash: the bank is the truth. */
const ADJUSTABLE: Record<string, string> = { [GL.RECEIVABLES]: 'receivables', [GL.UNAPPLIED_CASH]: 'unapplied' };
/** Above this, even an exact correction waits for a controller. */
const AUTO_LIMIT_CENTS = 50_000_000n;
const MIN_AUTO_CONFIDENCE = 0.8;

/**
 * A correcting journal for a books break. Checked here, against the latest tie-out: it balances,
 * touches only receivables and unapplied cash, only accounts that are actually off, and moves every
 * one of them closer to tying. It posts on its own (pol-016) only when it closes the difference to
 * the cent with confidence; anything partial waits for a controller.
 */
export const proposeAdjustingJournal = spacetimedb.reducer(
  { memo: t.string(), reasoning: t.string(), evidence: t.array(t.string()), lines: t.array(Line), confidence: t.f32() },
  (ctx, { memo, reasoning, evidence, lines, confidence }) => {
    requireRole(ctx, ['AGENT', 'CONTROLLER', 'ADMIN']);
    if (!evidence.length) throw new SenderError('cite the journals or payments that explain the difference');
    if (!lines.length || lines.some((l) => l.debitCents < 0n || l.creditCents < 0n || (l.debitCents > 0n) === (l.creditCents > 0n))) {
      throw new SenderError('each line is either a debit or a credit, and positive');
    }
    const debits = lines.reduce((s, l) => s + l.debitCents, 0n);
    if (debits !== lines.reduce((s, l) => s + l.creditCents, 0n)) throw new SenderError('the entry does not balance');
    const outside = lines.filter((l) => !ADJUSTABLE[l.account]);
    if (outside.length) throw new SenderError(`only receivables and unapplied cash can be adjusted, not ${outside.map((l) => l.account).join(', ')}`);

    const run = [...ctx.db.tieOutRun.iter()].reduce<{ id: bigint; status: string } | undefined>((a, r) => (!a || r.id > a.id ? r : a), undefined);
    if (!run || run.status !== 'break') throw new SenderError('the books tie: there is nothing to correct');
    const off = new Map<string, bigint>();
    for (const b of ctx.db.tieOutBreak.runId.filter(run.id)) if (b.kind === 'unexplained') off.set(b.area, b.amountCents);

    // What the entry does to each area's ledger figure (receivables: debit balance; unapplied: credit balance).
    const effect = new Map<string, bigint>();
    for (const l of lines) {
      const area = ADJUSTABLE[l.account]!;
      const d = area === 'receivables' ? l.debitCents - l.creditCents : l.creditCents - l.debitCents;
      effect.set(area, (effect.get(area) ?? 0n) + d);
    }
    const abs = (n: bigint) => (n < 0n ? -n : n);
    for (const [area, change] of effect) {
      const before = off.get(area);
      if (before === undefined) throw new SenderError(`${area} already ties; the entry would break it`);
      if (abs(before - change) >= abs(before)) throw new SenderError(`the entry moves ${area} further from tying`);
    }
    const exact = [...off].every(([area, before]) => before - (effect.get(area) ?? 0n) === 0n);
    const auto = exact && confidence >= MIN_AUTO_CONFIDENCE && debits <= AUTO_LIMIT_CENTS
      && [...ctx.db.policy.policyId.filter('pol-016')].some((p) => p.status === 'active');

    const item = createWorkItem(ctx, {
      kind: 'ADJUSTING_JOURNAL', clientId: BOOKS, subjectId: `tie_out_run:${run.id}`, amountCents: debits,
      title: `Correct the books: ${memo}`, proposal: { runId: String(run.id), memo, evidence, lines: lines.map(stringLine) },
      reasoning, policyRef: 'pol-016', confidence, requiredRole: 'CONTROLLER', autoApplied: auto,
    });
    stepChecks(ctx, item.id, [
      { ok: true, label: 'balances' },
      { ok: true, label: 'cash untouched' },
      { ok: exact, label: exact ? 'closes the difference to the cent' : 'closes part of the difference' },
      ...(auto ? [{ ok: true, label: 'no approval needed' }] : []),
    ], auto ? undefined : { waiting: `${exact ? 'Above the automatic limit' : 'Explains only part of the difference'}. Routed to a controller.` });
    if (auto) postAdjustingJournal(ctx, item.id);
  },
);

const stringLine = (l: AdjustingLine) => ({ account: l.account, debitCents: l.debitCents.toString(), creditCents: l.creditCents.toString() });

/** Approved (or applied under pol-016): the journal goes to the general ledger through the gateway. */
export function postAdjustingJournal(ctx: Ctx, workItemId: bigint) {
  const item = ctx.db.workItem.id.find(workItemId);
  if (!item) return;
  const p = JSON.parse(item.proposalJson) as { memo: string; evidence: string[]; lines: { account: string; debitCents: string; creditCents: string }[] };
  // The journal's ref names the payments it corrects, so the same cause is never corrected twice.
  queueJournal(ctx, `JE-ADJ-W${item.id}`, simDate(ctx), p.evidence.join(' ').slice(0, 200), `Adjusting entry: ${p.memo}`,
    p.lines.map((l) => ({ account: l.account, debitCents: BigInt(l.debitCents), creditCents: BigInt(l.creditCents) })), item.id);
}

