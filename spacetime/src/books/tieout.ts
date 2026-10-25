import { BOOKS, route, step } from '../agents';
import { audit, simDate, type Ctx } from '../context';
import { createWorkItem } from '../payments/apply';
import { GL } from '../payments/gateway';
import { formatUsd } from '../payments/match';

interface Area {
  area: string;
  /** What the operational side says (bank, invoices, unapplied cash). */
  subledgerCents: bigint;
  /** What the general ledger says. */
  glCents: bigint;
}

interface Break {
  area: string;
  kind: 'in_transit' | 'awaiting_gateway' | 'unexplained';
  amountCents: bigint;
  ref: string;
  detail: string;
}

const CASH_ACCOUNTS: Record<string, string> = { collections: '1010', disbursements: '1011', wallet: '1015' };

/**
 * Ties out the books as of now:
 *   cash per platform account   bank movements (posted)              vs GL 1010/1011/1015
 *   receivables                 open invoice balances (issued ≤ today) vs GL 1200
 *   unapplied cash              received but not applied to invoices  vs GL 2300
 * Differences explained by journals still queued for the gateway are expected;
 * anything else is unexplained and goes to the controller.
 */
export function runTieOut(ctx: Ctx, trigger: string) {
  // While a reset reloads the bank before the ledger, the two cannot agree yet; the reset ties out once it is whole.
  if (ctx.db.clock.id.find(1)?.settling) return;
  const today = simDate(ctx);

  // GL balances (debit − credit).
  const gl = new Map<string, bigint>();
  for (const l of ctx.db.ledgerEntry.iter()) gl.set(l.accountCode, (gl.get(l.accountCode) ?? 0n) + l.debitCents - l.creditCents);

  // Journals queued for the gateway, by account.
  const pendingByAccount = new Map<string, { cents: bigint; refs: string[] }>();
  for (const c of ctx.db.gatewayCommand.type.filter('POST_JOURNAL')) {
    if (c.status !== 'queued' && c.status !== 'executing') continue;
    const j = JSON.parse(c.actionJson).journal as { journalId: string; lines: { account: string; debitCents: string; creditCents: string }[] };
    for (const l of j.lines) {
      const cur = pendingByAccount.get(l.account) ?? { cents: 0n, refs: [] };
      cur.cents += BigInt(l.debitCents) - BigInt(l.creditCents);
      cur.refs.push(j.journalId);
      pendingByAccount.set(l.account, cur);
    }
  }

  const movements = [...ctx.db.cashMovement.iter()];
  const areas: Area[] = [];
  const breaks: Break[] = [];

  for (const [account, code] of Object.entries(CASH_ACCOUNTS)) {
    // Bank accounts: the statement's opening balance (which includes history) plus everything posted since.
    // The wallet has no statement: all its movements count.
    const statement = ctx.db.bankAccount.id.find(account);
    const bank = (statement?.openingCents ?? 0n) + movements
      .filter((m) => m.platformAccount === account && m.status === 'posted' && !(statement && m.isHistory))
      .reduce((s, m) => s + (m.direction === 'in' ? m.amountCents : -m.amountCents), 0n);
    areas.push({ area: `cash:${account}`, subledgerCents: bank, glCents: gl.get(code) ?? 0n });
    for (const m of movements.filter((x) => x.platformAccount === account && x.status === 'pending')) {
      breaks.push({ area: `cash:${account}`, kind: 'in_transit', amountCents: m.amountCents, ref: m.bankRef, detail: `${formatUsd(m.amountCents)} from ${m.origName} sent, not yet posted by the bank` });
    }
  }

  const receivables = [...ctx.db.invoice.iter()]
    .filter((i) => i.issuedOn <= today)
    .reduce((s, i) => s + i.amountCents - i.paidCents, 0n);
  areas.push({ area: 'receivables', subledgerCents: receivables, glCents: gl.get(GL.RECEIVABLES) ?? 0n });

  // Unapplied: cash received, minus what was applied to invoices (write-offs aren't cash).
  const applied = new Map<string, bigint>();
  for (const a of ctx.db.paymentApplication.iter()) {
    if (a.reversed || a.method === 'write_off') continue;
    applied.set(a.movementId, (applied.get(a.movementId) ?? 0n) + a.amountCents);
  }
  let unapplied = 0n;
  for (const m of movements) {
    if (m.direction !== 'in' || m.status !== 'posted') continue;
    if (m.matchStatus === 'reversed' || m.matchStatus === 'refunded') continue;
    if (m.refs.some((r) => r.startsWith('LN-'))) continue; // loan repayments go to the loan book
    unapplied += m.amountCents - (applied.get(m.id) ?? 0n);
  }
  // 2300 is a liability: its GL balance is a credit, so compare the negated balance.
  areas.push({ area: 'unapplied', subledgerCents: unapplied, glCents: -(gl.get(GL.UNAPPLIED_CASH) ?? 0n) });

  const glCode = (area: string) => (area.startsWith('cash:') ? CASH_ACCOUNTS[area.slice(5)]! : area === 'receivables' ? GL.RECEIVABLES : GL.UNAPPLIED_CASH);
  let unexplainedTotal = 0n;
  for (const a of areas) {
    const code = glCode(a.area);
    const pending = pendingByAccount.get(code);
    // Pending journals will move the GL by this much (liability sign flipped for 2300).
    const pendingCents = pending ? (code === GL.UNAPPLIED_CASH ? -pending.cents : pending.cents) : 0n;
    if (pending && pendingCents !== 0n) {
      breaks.push({ area: a.area, kind: 'awaiting_gateway', amountCents: pendingCents, ref: [...new Set(pending.refs)].join(' '), detail: `${pending.refs.length} journal line(s) queued, not yet posted` });
    }
    const unexplained = a.subledgerCents - a.glCents - pendingCents;
    if (unexplained !== 0n) {
      unexplainedTotal += unexplained < 0n ? -unexplained : unexplained;
      breaks.push({ area: a.area, kind: 'unexplained', amountCents: unexplained, ref: glCode(a.area), detail: `Operations say ${formatUsd(a.subledgerCents)}, ledger says ${formatUsd(a.glCents)}` });
    }
  }

  const status = unexplainedTotal !== 0n ? 'break' : breaks.length ? 'explained' : 'tied';
  const summary = Object.fromEntries(areas.map((a) => [a.area, { operations: a.subledgerCents.toString(), ledger: a.glCents.toString() }]));
  const run = ctx.db.tieOutRun.insert({
    id: 0n, simDate: today, at: ctx.timestamp, trigger, status, unexplainedCents: unexplainedTotal, summaryJson: JSON.stringify(summary),
  });
  for (const b of breaks) ctx.db.tieOutBreak.insert({ id: 0n, runId: run.id, ...b });

  // Logged, not escalated: one item per distinct unexplained amount, so reruns don't repeat it.
  const logged = [...ctx.db.workItem.iter()].some((w) => w.kind === 'BOOKS_BREAK' && w.amountCents === unexplainedTotal);
  if (status === 'break' && !logged) {
    const text = `Books don't tie: ${formatUsd(unexplainedTotal)} unexplained.`;
    step(ctx, { clientId: BOOKS, actor: 'payment', text, opens: text });
    route(ctx, 'books_break', BOOKS, text);
    createWorkItem(ctx, {
      kind: 'BOOKS_BREAK', clientId: '', subjectId: `tie_out_run:${run.id}`, amountCents: unexplainedTotal,
      title: `Books don't tie out: ${formatUsd(unexplainedTotal)} unexplained`,
      proposal: { runId: String(run.id), breaks: breaks.filter((b) => b.kind === 'unexplained').map((b) => ({ ...b, amountCents: b.amountCents.toString() })) },
      reasoning: 'Bank, ledger and receivables disagree by more than queued journals and in-transit items explain.',
      policyRef: '', confidence: 1, requiredRole: 'CONTROLLER', autoApplied: true,
    });
  }
  audit(ctx, { action: 'TIE_OUT', subjectType: 'tie_out_run', subjectId: String(run.id), toState: status, detail: `${trigger}: ${status}${unexplainedTotal ? `, ${formatUsd(unexplainedTotal)} unexplained` : ''}` });
  return run;
}
