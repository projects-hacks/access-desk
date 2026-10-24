import { addDays, audit, simDate, type Ctx } from '../context';

/**
 * Contract time: grace, then a default notice, then the cure period (§9.1)
 * before any restriction. Deadlines are evaluated whenever the sim date moves
 * (the scheduled clock or a manual advance) and closed early when a client pays.
 */

/** Under an open dispute that was already filed on `on`. */
const disputedOn = (ctx: Ctx, invoiceId: string, on: string) =>
  [...ctx.db.dispute.invoiceId.filter(invoiceId)].some((d) => d.status !== 'resolved' && d.openedOn <= on);

/** Invoices unpaid past their grace period on `on`, and not disputed by then. */
export function defaultedInvoices(ctx: Ctx, clientId: string, on = simDate(ctx)) {
  const grace = ctx.db.contract.clientId.find(clientId)?.graceDays ?? 0;
  return [...ctx.db.invoice.clientId.filter(clientId)].filter(
    (i) => i.paidCents < i.amountCents && addDays(i.dueOn, grace) < on && !disputedOn(ctx, i.id, on),
  );
}

export const inDefault = (ctx: Ctx, clientId: string) => defaultedInvoices(ctx, clientId).length > 0;

function latest(ctx: Ctx, clientId: string, kind: string) {
  return [...ctx.db.deadline.clientId.filter(clientId)].filter((d) => d.kind === kind).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
}

/** Where the client stands under the cure clause. */
export function cureState(ctx: Ctx, clientId: string): { state: 'none' | 'running' | 'expired'; dueOn?: string; startedOn?: string } {
  const d = latest(ctx, clientId, 'cure_period');
  if (!d || d.status === 'met') return { state: 'none' };
  return { state: d.status === 'expired' ? 'expired' : 'running', dueOn: d.dueOn, startedOn: d.startedOn };
}

/** A default notice went out: the cure period starts (once per default). */
export function startCure(ctx: Ctx, clientId: string, sentOn: string, workItemId?: bigint) {
  // In default when the notice went out; a dispute filed later is judged when the cure period ends.
  if (!defaultedInvoices(ctx, clientId, sentOn).length || cureState(ctx, clientId).state !== 'none') return;
  const days = ctx.db.contract.clientId.find(clientId)?.cureDays ?? 0;
  const d = ctx.db.deadline.insert({
    id: 0n, kind: 'cure_period', clientId, workItemId, startedOn: sentOn, dueOn: addDays(sentOn, days), status: 'open',
    clause: '9.1', note: `${days}-day cure period after notice of ${sentOn}`,
  });
  audit(ctx, { action: 'DEADLINE_SET', subjectType: 'deadline', subjectId: String(d.id), clientId, workItemId, toState: 'open', detail: `${d.note}, ends ${d.dueOn}` });
  evaluateDeadlines(ctx);
}

/** Everything due on or before the sim date resolves. */
export function evaluateDeadlines(ctx: Ctx) {
  const today = simDate(ctx);
  for (const d of [...ctx.db.deadline.iter()]) {
    if (d.status !== 'open' || d.dueOn > today) continue;
    const owing = inDefault(ctx, d.clientId);
    const status = d.kind === 'cure_period' ? (owing ? 'expired' : 'met')
      : d.kind === 'promise_to_pay' ? (owing ? 'broken' : 'met')
      : 'due';
    ctx.db.deadline.id.update({ ...d, status });
    audit(ctx, {
      action: 'DEADLINE_DUE', subjectType: 'deadline', subjectId: String(d.id), clientId: d.clientId, workItemId: d.workItemId,
      fromState: 'open', toState: status, detail: `${d.kind.replace(/_/g, ' ')} ${status} on ${today}${d.clause ? ` (§${d.clause})` : ''}`,
    });
  }
}

/** The client paid what was in default: open cure periods and promises are met now. */
export function closeDeadlinesIfCured(ctx: Ctx, clientId: string, cause: string) {
  if (inDefault(ctx, clientId)) return;
  for (const d of [...ctx.db.deadline.clientId.filter(clientId)]) {
    if (d.status === 'met' || d.kind === 'follow_up') continue;
    if (d.status !== 'open' && d.status !== 'expired') continue;
    ctx.db.deadline.id.update({ ...d, status: 'met' });
    audit(ctx, {
      action: 'DEADLINE_MET', subjectType: 'deadline', subjectId: String(d.id), clientId, workItemId: d.workItemId,
      fromState: d.status, toState: 'met', detail: `${d.kind.replace(/_/g, ' ')} met: ${cause}`,
    });
  }
}
