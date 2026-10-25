import { daysBetween, usd } from './format';
import { PROPOSAL_WORDS, defaultedInvoices, hedged, proposalOf, usdCash } from './helpers';
import type { ClientView, Move, PrecedentRow, WorkItemRow } from './model';

/** Decisions on the agent's restrictions, debits and exceptions become precedents, in the shape of the imported history. */
const LEARN_FROM = new Set(['RESTRICTION', 'CUSTODY_DEBIT', 'NOVEL_CASE']);
const DECISIONS: Record<string, string> = { APPROVED: 'Approved', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn' };

export function precedentsDue(v: ClientView, today: string): Move[] {
  const known = new Map(v.precedents.map((p) => [p.id, p]));
  const inDefault = defaultedInvoices(v, today).length > 0;
  const moves: Move[] = [];
  for (const event of [...v.rejections, ...v.approvals, ...v.withdrawals]) {
    const item = v.workItems.find((w) => w.id === event.workItemId);
    if (!item || !LEARN_FROM.has(item.kind)) continue;
    const id = `PRC-L${item.id}`;
    const existing = known.get(id);
    const decision = DECISIONS[event.toState]!;
    const outcome = inDefault ? '' : paidOutcome(v, event.simDate, decision, today);
    if (existing && (existing.outcome || !outcome)) continue;
    const auto = event.action === 'AUTO_APPLIED' ? ' Auto-applied under its policy.' : '';
    const row: PrecedentRow = existing
      ? { ...existing, workItemId: item.id, outcome }
      : {
        id, clientId: v.client.id, workItemId: item.id, decidedOn: event.simDate, situation: situation(v, item, event.simDate) + auto, proposed: proposedText(item),
        decision, overrideReason: decision === 'Rejected' ? event.detail : '', outcome, policyRef: item.policyRef, source: 'live',
      };
    moves.push({ kind: 'precedent', row, summary: `${existing ? 'update' : 'record'} precedent ${id}: ${decision.toLowerCase()}${outcome ? ` · ${outcome}` : ''}` });
  }
  return moves;
}

/** Invoices past due and not yet paid on a past date (paid_on is when they were fully paid). */
const unpaidOn = (v: ClientView, on: string) => v.invoices.filter((i) => i.dueOn < on && i.status !== 'disputed' && (!i.paidOn || i.paidOn > on));

/** Short facts as of the decision, like the history's "Late 23 days, coverage 0.7x, renewal in 12 days". */
function situation(v: ClientView, item: WorkItemRow, on: string): string {
  const late = unpaidOn(v, on);
  const parts: string[] = [];
  if (late.length) {
    const oldest = late.map((i) => i.dueOn).reduce((a, b) => (a < b ? a : b));
    const amount = late.reduce((s, i) => s + i.amountCents, 0);
    parts.push(`Late ${daysBetween(oldest, on)} days, ${usd(amount)} past due (${[...new Set(late.map((i) => i.product))].sort().join(', ')})`);
    if (amount) parts.push(`coverage ${(usdCash(v) / amount).toFixed(1)}×`);
  }
  const renewal = v.client.renewalOn;
  if (renewal && renewal >= on) parts.push(`renewal in ${daysBetween(on, renewal)} days`);
  parts.push(`tier ${v.client.tier}${v.client.strategic ? ', strategic' : ''}`);
  if (hedged(v)) parts.push('hedged positions open');
  if (item.kind === 'NOVEL_CASE') {
    const request = proposalOf(item);
    parts.push(`RM: ${String(request.summary || request.request || item.title).slice(0, 160)}`);
  }
  return parts.join(', ');
}

function proposedText(item: WorkItemRow): string {
  const p = proposalOf(item);
  if (item.kind === 'RESTRICTION' && p.step) {
    const words = p.step === 'HOLD_AMOUNT_OWED' ? 'Hold amount owed' : (PROPOSAL_WORDS[p.step] ?? p.step.replace(/_/g, ' ').replace(/^./, (c: string) => c.toUpperCase()));
    return `${words} (${p.lever ?? ''}, ${p.step})`;
  }
  if (item.kind === 'CUSTODY_DEBIT') return `Debit fees from custody (${(p.invoiceIds ?? []).join(', ')})`;
  return item.title;
}

function paidOutcome(v: ClientView, decidedOn: string, decision: string, today: string): string {
  const settled = v.invoices.filter((i) => i.dueOn < decidedOn && i.paidOn && i.paidOn > decidedOn).map((i) => i.paidOn!);
  const paid = settled.length ? settled.reduce((a, b) => (a > b ? a : b)) : today;
  if (decision === 'Withdrawn') return `Paid before the restriction applied (${paid})`;
  const days = daysBetween(decidedOn, paid);
  return days ? `Paid in ${days}d` : 'Paid the same day';
}
