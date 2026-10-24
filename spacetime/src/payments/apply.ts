import { audit, simDate, type Ctx } from '../context';
import { GL, cashAccount, cr, dr, isBooked, queueCommand, queueJournal, toJson } from './gateway';
import { formatUsd, normalizeName, type CandidateInvoice, type MatchPlan } from './match';

type Invoice = NonNullable<ReturnType<Ctx['db']['invoice']['id']['find']>>;
type Application = NonNullable<ReturnType<Ctx['db']['paymentApplication']['id']['find']>>;
export type Movement = NonNullable<ReturnType<Ctx['db']['cashMovement']['id']['find']>>;
export { toJson };

// ── Invoice state ───────────────────────────────────────────────────────────
//
// Billing's figure (source_paid_cents) and ours can differ while gateway
// commands are in flight. Per application:
//   we count it       = not reversed
//   billing counts it = (prior or posted) and its reversal isn't posted yet
// effective paid = billing's figure + Σ(we count − billing counts).

const weCount = (a: Application) => (a.reversed ? 0n : a.amountCents);
const billingCounts = (a: Application) => ((a.method === 'prior' || a.posted) && !a.reversalPosted ? a.amountCents : 0n);
const appsFor = (ctx: Ctx, invoiceId: string) => [...ctx.db.paymentApplication.invoiceId.filter(invoiceId)];

/** Cash billing applied that no movement has claimed yet. */
function priorAvailable(ctx: Ctx, inv: Invoice): bigint {
  return inv.sourcePaidCents - appsFor(ctx, inv.id).reduce((s, a) => s + billingCounts(a), 0n);
}

function hasOpenDispute(ctx: Ctx, invoiceId: string): boolean {
  return [...ctx.db.dispute.invoiceId.filter(invoiceId)].some((d) => d.status !== 'resolved');
}

/** Recompute paid amount, status and paid date. `paidOnIfCompleted`: value date of the cash that completed it. */
export function recomputeInvoice(ctx: Ctx, invoiceId: string, paidOnIfCompleted?: string) {
  const inv = ctx.db.invoice.id.find(invoiceId);
  if (!inv) return;
  const delta = appsFor(ctx, invoiceId).reduce((s, a) => s + weCount(a) - billingCounts(a), 0n);
  const paidCents = inv.sourcePaidCents + delta;
  const status = hasOpenDispute(ctx, invoiceId)
    ? 'disputed'
    : paidCents >= inv.amountCents ? 'paid' : paidCents > 0n ? 'partially_paid' : 'open';
  const paidOn = status === 'paid' ? (inv.paidOn ?? paidOnIfCompleted) : undefined;
  if (paidCents !== inv.paidCents || status !== inv.status || paidOn !== inv.paidOn) {
    ctx.db.invoice.id.update({ ...inv, paidCents, status, paidOn });
  }
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

// ── Books ───────────────────────────────────────────────────────────────────

/** Receipt journal for posted cash the ledger hasn't seen (treasury booked what arrived before our system ran). */
export function bookReceipt(ctx: Ctx, m: Movement, credit: string, workItemId?: bigint) {
  if (isBooked(ctx, m.bankRef)) return;
  queueJournal(ctx, `JE-R-${m.bankRef}`, m.valueOn, m.bankRef, `Receipt ${m.rail} from ${m.origName || m.origAccount}`,
    [dr(cashAccount(m.platformAccount), m.amountCents), cr(credit, m.amountCents)], workItemId);
}

// ── Applying ────────────────────────────────────────────────────────────────

/**
 * Writes the applications for a plan, then queues the billing update and the
 * journal. Cash first covers what billing already applied ('prior'), so nothing
 * is counted twice. Returns the newly applied amount.
 */
export function applyPlan(ctx: Ctx, m: Movement, clientId: string, plan: MatchPlan, policyRef: string, workItemId?: bigint): bigint {
  const fresh: Application[] = [];
  const touched = new Set<string>();
  for (const a of plan.allocations) {
    const inv = ctx.db.invoice.id.find(a.invoiceId);
    if (!inv) continue;
    const avail = priorAvailable(ctx, inv);
    const prior = a.amountCents < avail ? a.amountCents : avail > 0n ? avail : 0n;
    const rest = a.amountCents - prior;
    const base = { id: 0n, movementId: m.id, invoiceId: a.invoiceId, workItemId, reversed: false, reversalPosted: false };
    if (prior > 0n) ctx.db.paymentApplication.insert({ ...base, amountCents: prior, method: 'prior', policyRef: '', posted: true });
    if (rest > 0n) fresh.push(ctx.db.paymentApplication.insert({ ...base, amountCents: rest, method: plan.method, policyRef, posted: false }));
    touched.add(a.invoiceId);
  }
  const last = plan.allocations[plan.allocations.length - 1];
  if (plan.shortCents > 0n && last) {
    // The short amount closes the last invoice and is written off to bank fees.
    fresh.push(ctx.db.paymentApplication.insert({
      id: 0n, movementId: m.id, invoiceId: last.invoiceId, amountCents: plan.shortCents, method: 'write_off',
      policyRef: 'pol-002', workItemId, reversed: false, posted: false, reversalPosted: false,
    }));
  }
  if (plan.excessCents > 0n) {
    ctx.db.clientCredit.insert({ id: 0n, clientId, kind: 'overpayment', amountCents: plan.excessCents, movementId: m.id });
  }
  for (const id of touched) recomputeInvoice(ctx, id, m.valueOn);
  setMatchStatus(ctx, m.id, 'matched');

  if (fresh.length) {
    queueCommand(ctx, `APPLY:${m.id}:${fresh[0]!.id}`, {
      type: 'APPLY_PAYMENT', movementId: m.id, on: m.valueOn,
      applications: fresh.map((a) => ({ applicationId: String(a.id), invoiceId: a.invoiceId, amountCents: a.amountCents })),
    }, workItemId);
    const cash = fresh.filter((a) => a.method !== 'write_off').reduce((s, a) => s + a.amountCents, 0n);
    const writeOff = fresh.filter((a) => a.method === 'write_off').reduce((s, a) => s + a.amountCents, 0n);
    queueJournal(ctx, `JE-AP-${m.bankRef}-${fresh[0]!.id}`, m.valueOn, m.bankRef,
      `Applied to ${[...new Set(fresh.map((a) => a.invoiceId))].join(' ')}`,
      [dr(GL.UNAPPLIED_CASH, cash), dr(GL.BANK_FEES, writeOff), cr(GL.RECEIVABLES, cash + writeOff)], workItemId);
  }
  return fresh.reduce((s, a) => s + a.amountCents, 0n);
}

/**
 * Undo a movement's applications. Billing is told about all of them; the books
 * are reversed for our own (non-prior) applications.
 */
export function reverseApplications(ctx: Ctx, movementId: string, on: string, workItemId?: bigint): bigint {
  const apps = [...ctx.db.paymentApplication.movementId.filter(movementId)].filter((a) => !a.reversed);
  if (!apps.length) return 0n;
  for (const a of apps) ctx.db.paymentApplication.id.update({ ...a, reversed: true });
  queueCommand(ctx, `REVERSE:${movementId}:${apps[0]!.id}`, {
    type: 'REVERSE_PAYMENT', movementId, on,
    applications: apps.map((a) => ({ applicationId: String(a.id), invoiceId: a.invoiceId, amountCents: a.amountCents })),
  }, workItemId);
  const ours = apps.filter((a) => a.method !== 'prior');
  const cash = ours.filter((a) => a.method !== 'write_off').reduce((s, a) => s + a.amountCents, 0n);
  const writeOff = ours.filter((a) => a.method === 'write_off').reduce((s, a) => s + a.amountCents, 0n);
  const m = ctx.db.cashMovement.id.find(movementId);
  if (cash + writeOff > 0n && m) {
    queueJournal(ctx, `JE-RV-${m.bankRef}-${apps[0]!.id}`, on, m.bankRef, 'Application reversed',
      [dr(GL.RECEIVABLES, cash + writeOff), cr(GL.UNAPPLIED_CASH, cash), cr(GL.BANK_FEES, writeOff)], workItemId);
  }
  for (const id of new Set(apps.map((a) => a.invoiceId))) recomputeInvoice(ctx, id);
  return apps.reduce((s, a) => s + a.amountCents, 0n);
}

export function setMatchStatus(ctx: Ctx, movementId: string, matchStatus: string) {
  const m = ctx.db.cashMovement.id.find(movementId);
  if (m && m.matchStatus !== matchStatus) ctx.db.cashMovement.id.update({ ...m, matchStatus });
}

// ── Consequences ────────────────────────────────────────────────────────────

/** A hold comes off automatically once the invoices it secures are paid (pol-011). */
export function releaseHoldsIfCured(ctx: Ctx, clientId: string, cause: string, workItemId?: bigint) {
  let released = false;
  for (const h of [...ctx.db.hold.clientId.filter(clientId)]) {
    if (h.status !== 'active') continue;
    const cured = h.invoiceIds.length
      ? h.invoiceIds.every((id) => ctx.db.invoice.id.find(id)?.status === 'paid')
      : overdueCents(ctx, clientId) === 0n;
    if (!cured) continue;
    ctx.db.hold.id.update({ ...h, status: 'released', releasedAt: ctx.timestamp });
    queueCommand(ctx, `RELEASE_HOLD:${h.id}`, { type: 'RELEASE_HOLD', clientId, holdId: String(h.id) }, workItemId);
    audit(ctx, {
      action: 'HOLD_RELEASED', subjectType: 'hold', subjectId: String(h.id), clientId, workItemId,
      fromState: 'active', toState: 'released', policyRef: 'pol-011',
      detail: `${formatUsd(h.amountCents)} released after ${cause}`,
    });
    released = true;
  }
  if (!released) return;
  // Optimistic: the gateway confirms the lever state once the platform applies it.
  const stillHeld = [...ctx.db.hold.clientId.filter(clientId)].some((h) => h.status === 'active');
  const lever = ctx.db.accessLever.id.find(`${clientId}:withdrawals`);
  if (lever && !stillHeld) ctx.db.accessLever.id.update({ ...lever, state: 'active', detail: 'Hold released · all assets withdrawable', workItemId });
  const client = ctx.db.client.id.find(clientId);
  if (client && client.status === 'held' && !stillHeld) ctx.db.client.id.update({ ...client, status: 'active' });
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
