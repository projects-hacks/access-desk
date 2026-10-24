import { audit, simDate, type Ctx } from '../context';
import { formatUsd, normalizeName, type CandidateInvoice, type MatchPlan } from './match';

type Invoice = NonNullable<ReturnType<Ctx['db']['invoice']['id']['find']>>;
export type Movement = NonNullable<ReturnType<Ctx['db']['cashMovement']['id']['find']>>;

const jsonSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
export const toJson = (v: unknown) => JSON.stringify(v, jsonSafe);

// ── Invoice state ───────────────────────────────────────────────────────────

const activeApps = (ctx: Ctx, invoiceId: string) =>
  [...ctx.db.paymentApplication.invoiceId.filter(invoiceId)].filter((a) => !a.reversed);

/** Billing-applied cash not yet tied to a specific movement. */
function priorAvailable(ctx: Ctx, inv: Invoice): bigint {
  const attributed = activeApps(ctx, inv.id).filter((a) => a.method === 'prior').reduce((s, a) => s + a.amountCents, 0n);
  return inv.sourcePaidCents - attributed;
}

function hasOpenDispute(ctx: Ctx, invoiceId: string): boolean {
  return [...ctx.db.dispute.invoiceId.filter(invoiceId)].some((d) => d.status !== 'resolved');
}

/** Effective paid = billing's amount + our own applications. Status follows from it. */
export function recomputeInvoice(ctx: Ctx, invoiceId: string) {
  const inv = ctx.db.invoice.id.find(invoiceId);
  if (!inv) return;
  const ours = activeApps(ctx, invoiceId).filter((a) => a.method !== 'prior').reduce((s, a) => s + a.amountCents, 0n);
  const paidCents = inv.sourcePaidCents + ours;
  const status = hasOpenDispute(ctx, invoiceId)
    ? 'disputed'
    : paidCents >= inv.amountCents ? 'paid' : paidCents > 0n ? 'partially_paid' : 'open';
  if (paidCents !== inv.paidCents || status !== inv.status) ctx.db.invoice.id.update({ ...inv, paidCents, status });
}

/** Open invoices a payment can apply to. Disputed invoices are protected. */
export function candidates(ctx: Ctx, clientId: string): CandidateInvoice[] {
  return [...ctx.db.invoice.clientId.filter(clientId)]
    .filter((i) => i.status !== 'void' && !hasOpenDispute(ctx, i.id))
    .map((i) => ({
      id: i.id,
      dueOn: i.dueOn,
      amountCents: i.amountCents,
      balanceCents: i.amountCents - i.paidCents + priorAvailable(ctx, i),
    }));
}

/** Overdue balance on the sim date, excluding disputed invoices. */
export function overdueCents(ctx: Ctx, clientId: string): bigint {
  const today = simDate(ctx);
  return [...ctx.db.invoice.clientId.filter(clientId)]
    .filter((i) => i.dueOn < today && i.status !== 'disputed' && i.paidCents < i.amountCents)
    .reduce((s, i) => s + (i.amountCents - i.paidCents), 0n);
}

// ── Who paid ────────────────────────────────────────────────────────────────

export interface Payer {
  clientId: string;
  via: 'account' | 'wallet' | 'name' | 'client_reference' | 'invoice_reference';
  relation: string;
  label: string;
}

export function resolvePayer(ctx: Ctx, m: Movement): Payer | undefined {
  if (m.origAccount) {
    for (const p of ctx.db.payerIdentity.value.filter(m.origAccount)) {
      if ((p.kind === 'bank_account' || p.kind === 'wallet') && p.verified) {
        return { clientId: p.clientId, via: p.kind === 'wallet' ? 'wallet' : 'account', relation: p.relation, label: p.label };
      }
    }
  }
  if (m.origName) {
    const name = normalizeName(m.origName);
    for (const p of ctx.db.payerIdentity.iter()) {
      if ((p.kind === 'name_alias' || p.kind === 'affiliate') && normalizeName(p.value) === name) {
        return { clientId: p.clientId, via: 'name', relation: p.relation, label: p.label };
      }
    }
  }
  for (const ref of m.refs) {
    if (ref.startsWith('ORG-') && ctx.db.client.id.find(ref)) {
      return { clientId: ref, via: 'client_reference', relation: 'self', label: ref };
    }
  }
  for (const ref of m.refs) {
    const inv = ref.startsWith('INV-') ? ctx.db.invoice.id.find(ref) : undefined;
    if (inv) return { clientId: inv.clientId, via: 'invoice_reference', relation: 'self', label: ref };
  }
  return undefined;
}

// ── Applying ────────────────────────────────────────────────────────────────

/**
 * Writes the applications for a plan. Cash first covers what billing already
 * applied ('prior'), so nothing is counted twice. Returns the newly applied amount.
 */
export function applyPlan(ctx: Ctx, m: Movement, clientId: string, plan: MatchPlan, policyRef: string, workItemId?: bigint): bigint {
  let newlyApplied = 0n;
  const touched = new Set<string>();
  for (const a of plan.allocations) {
    const inv = ctx.db.invoice.id.find(a.invoiceId);
    if (!inv) continue;
    const avail = priorAvailable(ctx, inv);
    const prior = a.amountCents < avail ? a.amountCents : avail > 0n ? avail : 0n;
    const fresh = a.amountCents - prior;
    const base = { id: 0n, movementId: m.id, invoiceId: a.invoiceId, workItemId, reversed: false };
    if (prior > 0n) ctx.db.paymentApplication.insert({ ...base, amountCents: prior, method: 'prior', policyRef: '' });
    if (fresh > 0n) ctx.db.paymentApplication.insert({ ...base, amountCents: fresh, method: plan.method, policyRef });
    newlyApplied += fresh;
    touched.add(a.invoiceId);
  }
  if (plan.shortCents > 0n) {
    // The short amount closes the last invoice and is booked to bank fees.
    const last = plan.allocations[plan.allocations.length - 1];
    if (last) {
      ctx.db.paymentApplication.insert({
        id: 0n, movementId: m.id, invoiceId: last.invoiceId, amountCents: plan.shortCents, method: 'short_fee',
        policyRef: 'pol-002', workItemId, reversed: false,
      });
      newlyApplied += plan.shortCents;
    }
  }
  if (plan.excessCents > 0n) {
    ctx.db.clientCredit.insert({ id: 0n, clientId, kind: 'overpayment', amountCents: plan.excessCents, movementId: m.id });
  }
  for (const id of touched) recomputeInvoice(ctx, id);
  setMatchStatus(ctx, m.id, 'matched');
  return newlyApplied;
}

/** Undo a movement's applications (returned payment, or cash removed from the source). */
export function reverseApplications(ctx: Ctx, movementId: string, workItemId?: bigint): bigint {
  let reversed = 0n;
  const touched = new Set<string>();
  for (const a of [...ctx.db.paymentApplication.movementId.filter(movementId)]) {
    if (a.reversed || a.method === 'reversal') continue;
    ctx.db.paymentApplication.id.update({ ...a, reversed: true });
    if (a.method === 'prior') {
      // Billing counted this cash; offset it so the invoice reopens.
      ctx.db.paymentApplication.insert({
        id: 0n, movementId, invoiceId: a.invoiceId, amountCents: -a.amountCents, method: 'reversal',
        policyRef: 'pol-015', workItemId, reversed: false,
      });
    }
    reversed += a.amountCents;
    touched.add(a.invoiceId);
  }
  for (const id of touched) recomputeInvoice(ctx, id);
  return reversed;
}

export function setMatchStatus(ctx: Ctx, movementId: string, matchStatus: string) {
  const m = ctx.db.cashMovement.id.find(movementId);
  if (m && m.matchStatus !== matchStatus) ctx.db.cashMovement.id.update({ ...m, matchStatus });
}

// ── Consequences ────────────────────────────────────────────────────────────

/** A hold comes off automatically once the invoices it secures are paid (pol-011). */
export function releaseHoldsIfCured(ctx: Ctx, clientId: string, cause: string, workItemId?: bigint) {
  for (const h of [...ctx.db.hold.clientId.filter(clientId)]) {
    if (h.status !== 'active') continue;
    const secured = h.invoiceIds.map((id) => ctx.db.invoice.id.find(id));
    const cured = h.invoiceIds.length
      ? secured.every((i) => !i || i.status === 'paid')
      : overdueCents(ctx, clientId) === 0n;
    if (!cured) continue;
    ctx.db.hold.id.update({ ...h, status: 'released', releasedAt: ctx.timestamp });
    const lever = ctx.db.accessLever.id.find(`${clientId}:withdrawals`);
    if (lever) ctx.db.accessLever.id.update({ ...lever, state: 'active', detail: 'Hold released · all assets withdrawable', workItemId });
    ctx.db.gatewayCommand.insert({
      id: 0n, workItemId: workItemId ?? 0n, actionJson: toJson({ type: 'RELEASE_HOLD', clientId, holdId: h.id }),
      status: 'queued', externalRef: undefined, attempts: 0, error: undefined,
    });
    audit(ctx, {
      action: 'HOLD_RELEASED', subjectType: 'hold', subjectId: String(h.id), clientId, workItemId,
      fromState: 'active', toState: 'released', policyRef: 'pol-011',
      detail: `${formatUsd(h.amountCents)} released after ${cause}`,
    });
  }
  const client = ctx.db.client.id.find(clientId);
  if (client && client.status === 'held') ctx.db.client.id.update({ ...client, status: 'active' });
}

/** Restriction proposals for a client who is no longer overdue are withdrawn. */
export function withdrawStaleProposals(ctx: Ctx, clientId: string, cause: string) {
  if (overdueCents(ctx, clientId) > 0n) return;
  for (const w of [...ctx.db.workItem.clientId.filter(clientId)]) {
    if (!['RESTRICTION', 'CUSTODY_DEBIT', 'REMINDER'].includes(w.kind)) continue;
    if (w.state !== 'PROPOSED' && w.state !== 'NEEDS_INFO') continue;
    ctx.db.workItem.id.update({ ...w, state: 'WITHDRAWN', updatedAt: ctx.timestamp });
    audit(ctx, {
      action: 'TRANSITION', subjectType: 'work_item', subjectId: String(w.id), clientId, workItemId: w.id,
      fromState: w.state, toState: 'WITHDRAWN', detail: `No longer overdue: ${cause}`,
    });
  }
}

// ── Work items ──────────────────────────────────────────────────────────────

interface WorkItemInput {
  kind: string;
  clientId: string;
  subjectId: string;
  title: string;
  amountCents: bigint;
  proposal: unknown;
  reasoning: string;
  policyRef: string;
  confidence: number;
  requiredRole: string;
  autoApplied: boolean;
}

export function createWorkItem(ctx: Ctx, w: WorkItemInput) {
  const state = w.autoApplied ? 'APPROVED' : 'PROPOSED';
  const item = ctx.db.workItem.insert({
    id: 0n, kind: w.kind, clientId: w.clientId, subjectId: w.subjectId, state, title: w.title, amountCents: w.amountCents,
    proposalJson: toJson(w.proposal), reasoning: w.reasoning, policyRef: w.policyRef, clausesCited: [], boundariesJson: '[]',
    confidence: w.confidence, autoApplied: w.autoApplied, requiredRole: w.requiredRole, proposedBy: ctx.sender, revision: 1,
    revisedFrom: undefined, expiresOn: undefined, createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
  });
  audit(ctx, {
    action: w.autoApplied ? 'AUTO_APPLIED' : 'PROPOSE', subjectType: 'work_item', subjectId: String(item.id),
    clientId: w.clientId, workItemId: item.id, fromState: 'NEW', toState: state, detail: w.title, policyRef: w.policyRef,
  });
  return item;
}
