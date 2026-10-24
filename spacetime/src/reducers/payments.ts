import { SenderError, t } from 'spacetimedb/server';
import { audit, requireRole, simDate, type Ctx } from '../context';
import {
  applyPlan, bookReceipt, candidates, createWorkItem, releaseHoldsIfCured, resolvePayer, reverseApplications,
  setMatchStatus, withdrawStaleProposals, type Movement, type Payer,
} from '../payments/apply';
import { GL, cashAccount, cr, dr, isBooked, queueCommand, queueJournal } from '../payments/gateway';
import { formatUsd, planMatch, type MatchPlan } from '../payments/match';
import { spacetimedb } from '../schema';

/**
 * Payment checking. Runs in the same transaction as the cash being recorded,
 * so a payment, its application and any hold release land together.
 */
export function onCashMovement(ctx: Ctx, m: Movement, previous: Movement | undefined) {
  if (m.direction === 'in') onIncoming(ctx, m, previous);
  else onOutgoing(ctx, m);
}

/** Cash removed from the source: undo whatever it did. */
export function onCashRemoved(ctx: Ctx, m: Movement) {
  const today = ctx.db.clock.id.find(1)?.simDate ?? m.valueOn;
  const undone = reverseApplications(ctx, m.id, today);
  if ([...ctx.db.ledgerEntry.journalId.filter(`JE-R-${m.bankRef}`)].length || isBooked(ctx, m.bankRef, `JE-R-${m.bankRef}`)) {
    const cash = cashAccount(m.platformAccount);
    const lines = m.direction === 'in' ? [dr(GL.UNAPPLIED_CASH, m.amountCents), cr(cash, m.amountCents)] : [dr(cash, m.amountCents), cr(GL.UNAPPLIED_CASH, m.amountCents)];
    queueJournal(ctx, `JE-RVR-${m.bankRef}`, today, `${m.bankRef}:removed`, 'Receipt reversed: removed from bank', lines);
  }
  if (undone !== 0n) {
    audit(ctx, { action: 'APPLICATIONS_REVERSED', subjectType: 'cash_movement', subjectId: m.id, detail: `${m.bankRef} removed from source` });
  }
}

function onIncoming(ctx: Ctx, m: Movement, previous: Movement | undefined) {
  if (m.matchStatus !== 'unmatched' && m.matchStatus !== 'in_transit') return;
  const payer = resolvePayer(ctx, m);

  if (m.status === 'pending') {
    if (m.matchStatus === 'unmatched') {
      setMatchStatus(ctx, m.id, 'in_transit');
      audit(ctx, {
        action: 'CASH_IN_TRANSIT', subjectType: 'cash_movement', subjectId: m.id, clientId: payer?.clientId,
        detail: `${formatUsd(m.amountCents)} ${m.rail} from ${m.origName} sent, not yet posted. No action on this client until it posts.`,
      });
    }
    return;
  }
  if (m.status !== 'posted') {
    setMatchStatus(ctx, m.id, m.status);
    return;
  }

  // Loan repayments settle against the loan book, not invoices.
  const loanRef = m.refs.find((r) => r.startsWith('LN-'));
  if (loanRef && ctx.db.loan.id.find(loanRef)) {
    bookReceipt(ctx, m, GL.LOANS);
    setMatchStatus(ctx, m.id, 'matched');
    audit(ctx, { action: 'CASH_RECONCILED', subjectType: 'cash_movement', subjectId: m.id, clientId: payer?.clientId, detail: `Loan repayment ${loanRef} · ${formatUsd(m.amountCents)}` });
    return;
  }

  // Cash in the bank is on the books first (unapplied), whatever happens next.
  bookReceipt(ctx, m, GL.UNAPPLIED_CASH);

  if (!payer) {
    setMatchStatus(ctx, m.id, 'exception');
    createWorkItem(ctx, {
      kind: 'UNIDENTIFIED_CASH', clientId: '', subjectId: m.id, amountCents: m.amountCents,
      title: `Unidentified ${formatUsd(m.amountCents)} ${m.rail} from ${m.origName || m.origAccount}`,
      proposal: { movementId: m.id, origAccount: m.origAccount, origName: m.origName },
      reasoning: 'The sender is not in the CRM and the payment quotes no client or invoice. Nobody is restricted while this is open.',
      policyRef: 'pol-001', confidence: 0, requiredRole: 'ACCOUNTANT', autoApplied: false,
    });
    return;
  }

  const invoiceRefs = m.refs.filter((r) => r.startsWith('INV-'));
  const cands = candidates(ctx, payer.clientId);
  const fullyPaid = invoiceRefs.filter((id) => {
    const inv = ctx.db.invoice.id.find(id);
    return inv?.clientId === payer.clientId && !cands.some((c) => c.id === id && c.balanceCents > 0n);
  });
  // No invoice numbers but the payer described what it pays (read by Claude): try those invoices first.
  const hints = readHints(m);
  let result = planMatch(m.amountCents, cands, invoiceRefs, fullyPaid, m.chargesCents ?? 0n);
  if (!invoiceRefs.length && hints && hints.periods.length) {
    const described = cands.filter((c) => {
      const inv = ctx.db.invoice.id.find(c.id);
      return inv && hints.periods.includes(inv.period) && (!hints.products.length || hints.products.includes(inv.product));
    });
    const byDescription = planMatch(m.amountCents, described, [], []);
    if (byDescription.kind === 'plan' && byDescription.plan.method !== 'partial') {
      byDescription.plan.basis = `Matches what the payer described (${hints.periods.join(', ')} ${hints.products.map((p) => p.toLowerCase()).join(' and ')} fees)`;
      result = byDescription;
    }
  }
  if (result.kind === 'plan' && result.plan.method === 'short_fee' && m.chargesCents === result.plan.shortCents) {
    result.plan.basis = `${result.plan.basis}. Wire sent ${formatUsd(m.instructedCents ?? 0n)} with ${m.chargeBearer ?? 'SHA'} charges; an intermediary bank deducted ${formatUsd(m.chargesCents)} on the way`;
  }
  const foreignRefs = invoiceRefs.filter((id) => { const inv = ctx.db.invoice.id.find(id); return inv && inv.clientId !== payer.clientId; });
  if (result.kind === 'plan' && foreignRefs.length) {
    result.plan.basis = `${result.plan.basis}. Note: quoted ${foreignRefs.join(', ')}, which belong to another client`;
  }

  if (result.kind === 'duplicate') {
    setMatchStatus(ctx, m.id, 'exception');
    ctx.db.clientCredit.insert({ id: 0n, clientId: payer.clientId, kind: 'unapplied_cash', amountCents: m.amountCents, movementId: m.id });
    createWorkItem(ctx, {
      kind: 'REFUND', clientId: payer.clientId, subjectId: m.id, amountCents: m.amountCents,
      title: `Possible duplicate: ${formatUsd(m.amountCents)} for ${result.invoiceIds.join(', ')}, already paid`,
      proposal: { movementId: m.id, refundCents: m.amountCents, invoices: result.invoiceIds },
      reasoning: 'Every quoted invoice was already paid by an earlier wire with the same amount. The cash is held as unapplied credit; refund it or keep it as credit.',
      policyRef: 'pol-013', confidence: 0.9, requiredRole: 'CONTROLLER', autoApplied: false,
    });
    return;
  }
  if (result.kind === 'none') {
    setMatchStatus(ctx, m.id, 'exception');
    ctx.db.clientCredit.insert({ id: 0n, clientId: payer.clientId, kind: 'unapplied_cash', amountCents: m.amountCents, movementId: m.id });
    createWorkItem(ctx, {
      kind: 'UNAPPLIED_CASH', clientId: payer.clientId, subjectId: m.id, amountCents: m.amountCents,
      title: `${formatUsd(m.amountCents)} from ${m.origName} with nothing to apply to`,
      proposal: { movementId: m.id }, reasoning: result.reason, policyRef: 'pol-001', confidence: 0.5,
      requiredRole: 'ACCOUNTANT', autoApplied: false,
    });
    return;
  }

  const plan = result.plan;
  const trusted = payer.via === 'account' || payer.via === 'wallet';
  const auto = trusted && (plan.method !== 'partial' || plan.usedReferences);
  const policyRef = plan.method === 'short_fee' ? 'pol-002' : plan.method === 'overpaid' ? 'pol-012' : payer.relation !== 'self' ? 'pol-004' : 'pol-001';

  if (!auto) {
    setMatchStatus(ctx, m.id, 'proposed');
    const newIdentity = payer.via === 'name' && m.origAccount ? { kind: 'bank_account', value: m.origAccount, label: `${m.origName} · new account` } : undefined;
    createWorkItem(ctx, {
      kind: 'PAYMENT_MATCH', clientId: payer.clientId, subjectId: m.id, amountCents: m.amountCents,
      title: `Confirm ${formatUsd(m.amountCents)} from ${m.origName} → ${plan.allocations.map((a) => a.invoiceId).join(', ')}`,
      proposal: { movementId: m.id, plan, newIdentity },
      reasoning: `${plan.basis}. Payer identified by ${describeVia(payer)}${newIdentity ? `; account ${m.origAccount} is not in the CRM yet and will be added on approval` : ''}.`,
      policyRef, confidence: payer.via === 'name' ? 0.8 : 0.6, requiredRole: 'ACCOUNTANT', autoApplied: false,
    });
    return;
  }

  // Cash billing already applied (history) reconciles quietly; anything new becomes a visible auto-applied item.
  const item = isAlreadyApplied(ctx, plan)
    ? undefined
    : createWorkItem(ctx, {
        kind: 'PAYMENT_MATCH', clientId: payer.clientId, subjectId: m.id, amountCents: m.amountCents,
        title: matchTitle(m, plan, payer), proposal: { movementId: m.id, plan },
        reasoning: `${plan.basis}. Payer identified by ${describeVia(payer)}.`,
        policyRef, confidence: 0.98, requiredRole: 'ACCOUNTANT', autoApplied: true,
      });
  const applied = applyPlan(ctx, m, payer.clientId, plan, policyRef, item?.id);
  if (!item && !m.isHistory) {
    audit(ctx, { action: 'CASH_RECONCILED', subjectType: 'cash_movement', subjectId: m.id, clientId: payer.clientId, detail: `${m.bankRef} already applied in billing` });
  }
  if (applied > 0n) {
    const cause = `${m.bankRef} from ${m.origName}`;
    withdrawStaleProposals(ctx, payer.clientId, cause);
    releaseHoldsIfCured(ctx, payer.clientId, cause, item?.id);
  }
  void previous;
}

function isAlreadyApplied(ctx: Ctx, plan: MatchPlan): boolean {
  // Every allocation is covered by cash billing already counted.
  return plan.shortCents === 0n && plan.excessCents === 0n && plan.allocations.every((a) => {
    const inv = ctx.db.invoice.id.find(a.invoiceId);
    if (!inv) return false;
    const attributed = [...ctx.db.paymentApplication.invoiceId.filter(a.invoiceId)]
      .filter((x) => !x.reversed && x.method === 'prior').reduce((s, x) => s + x.amountCents, 0n);
    return inv.sourcePaidCents - attributed >= a.amountCents;
  });
}

function describeVia(p: Payer): string {
  const rel = p.relation !== 'self' ? ` (${p.relation.toLowerCase()} of the client, per CRM)` : '';
  switch (p.via) {
    case 'account': return `bank account on file: ${p.label}${rel}`;
    case 'wallet': return `known wallet: ${p.label}`;
    case 'name': return `name only: ${p.label}`;
    case 'client_reference': return 'client id quoted in the payment';
    case 'invoice_reference': return 'invoice number quoted in the payment';
  }
}

function matchTitle(m: Movement, plan: MatchPlan, payer: Payer): string {
  const rail = m.rail === 'USDC' ? 'USDC' : m.rail.toLowerCase();
  const invoices = plan.allocations.map((a) => a.invoiceId).join(', ');
  const parts = [`Matched ${formatUsd(m.amountCents)} ${rail} to ${invoices}`];
  if (plan.shortCents > 0n) parts.push(`${formatUsd(plan.shortCents)} to bank fees`);
  if (plan.excessCents > 0n) parts.push(`${formatUsd(plan.excessCents)} held as credit`);
  if (payer.relation !== 'self') parts.push(`paid by ${m.origName}`);
  if (plan.method === 'partial') parts.push('partial');
  return parts.join(' · ');
}

function onOutgoing(ctx: Ctx, m: Movement) {
  if (m.matchStatus !== 'unmatched' || m.status !== 'posted') return;
  const cash = cashAccount(m.platformAccount);
  if (m.reverses) {
    const original = [...ctx.db.cashMovement.bankRef.filter(m.reverses)][0];
    if (!original) throw new SenderError(`${m.bankRef} reverses unknown ${m.reverses}`);
    const item = createWorkItem(ctx, {
      kind: 'PAYMENT_REVERSAL', clientId: resolvePayer(ctx, original)?.clientId ?? '', subjectId: m.id,
      amountCents: m.amountCents, title: `${original.bankRef} returned (ACH ${m.returnCode ?? 'return'}) · invoices reopened`,
      proposal: { movementId: m.id, reverses: original.id }, policyRef: 'pol-015', confidence: 1,
      reasoning: 'The bank returned this payment after it was applied, so the applications are reversed and the invoices are due again.',
      requiredRole: 'ACCOUNTANT', autoApplied: true,
    });
    reverseApplications(ctx, original.id, m.valueOn, item.id);
    // Cash left the bank and the invoices are owed again.
    if (!isBooked(ctx, m.bankRef)) {
      queueJournal(ctx, `JE-R-${m.bankRef}`, m.valueOn, m.bankRef, `Returned payment ${original.bankRef}`,
        [dr(GL.RECEIVABLES, m.amountCents), cr(cash, m.amountCents)], item.id);
    }
    setMatchStatus(ctx, original.id, 'reversed');
    setMatchStatus(ctx, m.id, 'matched');
    return;
  }

  const refunded = m.refs.map((r) => [...ctx.db.cashMovement.bankRef.filter(r)].find((x) => x.direction === 'in')).find(Boolean);
  const loanRef = m.refs.find((r) => r.startsWith('LN-'));
  if (m.category === 'fee') {
    if (!isBooked(ctx, m.bankRef)) queueJournal(ctx, `JE-R-${m.bankRef}`, m.valueOn, m.bankRef, 'Bank fees', [dr(GL.BANK_FEES, m.amountCents), cr(cash, m.amountCents)]);
  } else if (loanRef) {
    if (!isBooked(ctx, m.bankRef)) queueJournal(ctx, `JE-R-${m.bankRef}`, m.valueOn, m.bankRef, `Loan disbursed ${loanRef}`, [dr(GL.LOANS, m.amountCents), cr(cash, m.amountCents)]);
  } else if (refunded) {
    // Refund of unapplied cash (e.g. a duplicate wire).
    if (!isBooked(ctx, m.bankRef)) queueJournal(ctx, `JE-R-${m.bankRef}`, m.valueOn, m.bankRef, `Refund of ${refunded.bankRef}`, [dr(GL.UNAPPLIED_CASH, m.amountCents), cr(cash, m.amountCents)]);
    for (const c of [...ctx.db.clientCredit.iter()].filter((x) => x.movementId === refunded.id && x.kind === 'unapplied_cash')) {
      ctx.db.clientCredit.id.delete(c.id);
    }
    setMatchStatus(ctx, refunded.id, 'refunded');
  } else {
    setMatchStatus(ctx, m.id, 'exception');
    createWorkItem(ctx, {
      kind: 'UNIDENTIFIED_CASH', clientId: '', subjectId: m.id, amountCents: m.amountCents,
      title: `Unexplained ${formatUsd(m.amountCents)} leaving ${m.platformAccount}`,
      proposal: { movementId: m.id }, reasoning: 'Money left a platform account with no matching instruction.',
      policyRef: '', confidence: 0, requiredRole: 'CONTROLLER', autoApplied: false,
    });
    return;
  }
  setMatchStatus(ctx, m.id, 'matched');
}

// ── Decisions on payment work items ─────────────────────────────────────────

/** Called when a payment work item is approved: apply the proposed match. */
export function onPaymentApproved(ctx: Ctx, workItemId: bigint) {
  const item = ctx.db.workItem.id.find(workItemId);
  if (item?.kind === 'REFUND') {
    const p = JSON.parse(item.proposalJson) as { movementId: string; refundCents: string };
    const original = ctx.db.cashMovement.id.find(p.movementId);
    if (!original) throw new SenderError(`movement ${p.movementId} no longer exists`);
    const today = ctx.db.clock.id.find(1)?.simDate ?? original.valueOn;
    queueCommand(ctx, `REFUND:${p.movementId}`, {
      type: 'REFUND', clientId: item.clientId, movementId: p.movementId, bankRef: original.bankRef,
      amountCents: BigInt(p.refundCents), on: today,
    }, item.id);
    return;
  }
  if (!item || item.kind !== 'PAYMENT_MATCH') return;
  const proposal = JSON.parse(item.proposalJson) as {
    movementId: string;
    plan: MatchPlan & { allocations: { invoiceId: string; amountCents: string }[]; shortCents: string; excessCents: string };
    newIdentity?: { kind: string; value: string; label: string };
  };
  const m = ctx.db.cashMovement.id.find(proposal.movementId);
  if (!m) throw new SenderError(`movement ${proposal.movementId} no longer exists`);
  const plan: MatchPlan = {
    ...proposal.plan,
    allocations: proposal.plan.allocations.map((a) => ({ invoiceId: a.invoiceId, amountCents: BigInt(a.amountCents) })),
    shortCents: BigInt(proposal.plan.shortCents),
    excessCents: BigInt(proposal.plan.excessCents),
  };
  if (proposal.newIdentity) {
    const id = `${item.clientId}:acct:${proposal.newIdentity.value}`;
    if (!ctx.db.payerIdentity.id.find(id)) {
      ctx.db.payerIdentity.insert({ id, clientId: item.clientId, ...proposal.newIdentity, relation: 'self', verified: true });
    }
  }
  const applied = applyPlan(ctx, m, item.clientId, plan, item.policyRef, item.id);
  if (applied > 0n) {
    withdrawStaleProposals(ctx, item.clientId, `${m.bankRef} confirmed`);
    releaseHoldsIfCured(ctx, item.clientId, `${m.bankRef} confirmed`, item.id);
  }
}

// ── Admin tool until the gateway's hold flow exists ─────────────────────────

/** Places a hold the way an approved restriction would. ADMIN only; for setup and tests. */
export const placeHold = spacetimedb.reducer(
  { clientId: t.string(), amountCents: t.i64(), reason: t.string(), clause: t.string() },
  (ctx, args) => {
    requireRole(ctx, ['ADMIN']);
    if (!ctx.db.client.id.find(args.clientId)) throw new SenderError(`unknown client ${args.clientId}`);
    // Secures the client's overdue, undisputed invoices as of today.
    const today = simDate(ctx);
    const invoiceIds = [...ctx.db.invoice.clientId.filter(args.clientId)]
      .filter((i) => i.dueOn < today && i.status !== 'disputed' && i.paidCents < i.amountCents)
      .map((i) => i.id);
    const hold = ctx.db.hold.insert({
      id: 0n, ...args, invoiceIds, workItemId: undefined, status: 'active', createdAt: ctx.timestamp, releasedAt: undefined,
    });
    queueCommand(ctx, `PLACE_HOLD:${hold.id}`, {
      type: 'PLACE_HOLD', clientId: args.clientId, holdId: String(hold.id), amountCents: args.amountCents, clause: args.clause,
    });
    const lever = ctx.db.accessLever.id.find(`${args.clientId}:withdrawals`);
    if (lever) ctx.db.accessLever.id.update({ ...lever, state: 'limited', detail: `${formatUsd(args.amountCents)} held (§${args.clause})` });
    const client = ctx.db.client.id.find(args.clientId);
    if (client) ctx.db.client.id.update({ ...client, status: 'held' });
    audit(ctx, { action: 'HOLD_PLACED', subjectType: 'hold', subjectId: String(hold.id), clientId: args.clientId, toState: 'active', detail: `${formatUsd(args.amountCents)} · ${args.reason} · secures ${invoiceIds.join(', ')}` });
  },
);

interface Hints {
  periods: string[];
  products: string[];
}

function readHints(m: Movement): Hints | undefined {
  if (!m.hintsJson) return undefined;
  try {
    const h = JSON.parse(m.hintsJson) as Partial<Hints>;
    return { periods: h.periods ?? [], products: h.products ?? [] };
  } catch {
    return undefined;
  }
}
