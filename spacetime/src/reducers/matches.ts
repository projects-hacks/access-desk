import { SenderError, t } from 'spacetimedb/server';
import { lowConfidence } from '../autonomy';
import { audit, requireRole, type Ctx } from '../context';
import { candidates, createWorkItem, setMatchStatus } from '../payments/apply';
import { formatUsd, planMatch } from '../payments/match';
import { spacetimedb } from '../schema';
import { onPaymentApproved } from './payments';

const OPEN = ['PROPOSED', 'NEEDS_INFO'];

/**
 * An agent attributes cash the matcher could not place (an unknown sender, or a
 * known one it would not apply alone) to a client, with its evidence, for an
 * accountant to approve once. The plan comes from the same matcher as every
 * other payment; approval runs the normal PAYMENT_MATCH path.
 */
export const proposePaymentMatch = spacetimedb.reducer(
  {
    movementId: t.string(), clientId: t.string(), reasoning: t.string(), evidenceJson: t.string(), confidence: t.f32(),
    rmNoteId: t.u64().optional(),
  },
  (ctx, { movementId, clientId, reasoning, evidenceJson, confidence, rmNoteId }) => {
    requireRole(ctx, ['AGENT', 'ADMIN']);
    try {
      JSON.parse(evidenceJson);
    } catch {
      throw new SenderError('evidenceJson must be JSON');
    }
    // The agent applies it itself; only below the confidence floor does a person confirm it.
    matchToClient(ctx, movementId, clientId, { reasoning, evidenceJson, confidence, rmNoteId, auto: !lowConfidence(confidence), by: 'agent' });
  },
);

/**
 * A person places cash nobody could identify: it applies at once (they are the person in the loop),
 * through the same matcher as every other payment.
 */
export const claimCash = spacetimedb.reducer(
  { movementId: t.string(), clientId: t.string(), reasoning: t.string() },
  (ctx, { movementId, clientId, reasoning }) => {
    requireRole(ctx, ['CONTROLLER', 'ACCOUNTANT', 'ADMIN']);
    matchToClient(ctx, movementId, clientId, { reasoning: reasoning.trim() || 'Placed by a person.', evidenceJson: '[]', confidence: 1, auto: true, by: 'person' });
  },
);

/** Attribute posted incoming cash to a client and apply it (or leave it for an accountant to confirm). */
export function matchToClient(
  ctx: Ctx, movementId: string, clientId: string,
  o: { reasoning: string; evidenceJson: string; confidence: number; rmNoteId?: bigint; auto: boolean; by: 'agent' | 'person' },
) {
  const m = ctx.db.cashMovement.id.find(movementId);
  if (!m) throw new SenderError(`unknown movement ${movementId}`);
  if (m.direction !== 'in' || m.status !== 'posted') throw new SenderError(`${m.bankRef} is not posted incoming cash`);
  if (m.matchStatus !== 'unmatched' && m.matchStatus !== 'exception') throw new SenderError(`${m.bankRef} is ${m.matchStatus}`);
  const c = ctx.db.client.id.find(clientId);
  if (!c) throw new SenderError(`unknown client ${clientId}`);
  const waiting = [...ctx.db.workItem.iter()].find((w) => w.kind === 'PAYMENT_MATCH' && w.subjectId === movementId && OPEN.includes(w.state));
  if (waiting) throw new SenderError(`a match for ${m.bankRef} is already waiting (WI-${waiting.id})`);

  const referenced = m.refs.filter((r) => r.startsWith('INV-'));
  const result = planMatch(m.amountCents, candidates(ctx, clientId), referenced, [], m.chargesCents ?? 0n);
  if (result.kind !== 'plan') {
    throw new SenderError(result.kind === 'none' ? result.reason : `${m.bankRef} pays invoices ${c.name} already paid`);
  }
  const plan = result.plan;
  const payer = m.origAccount || m.origName;
  const known = payer && [...ctx.db.payerIdentity.value.filter(payer)].some((p) => p.clientId === clientId);
  const newIdentity = payer && !known
    ? { kind: m.rail === 'USDC' ? 'wallet' : 'bank_account', value: payer, label: `${m.origName || 'Wallet'} · pays for ${c.name}` }
    : undefined;

  setMatchStatus(ctx, m.id, 'proposed');
  const invoices = plan.allocations.map((a) => a.invoiceId).join(', ');
  const item = createWorkItem(ctx, {
    kind: 'PAYMENT_MATCH', clientId, subjectId: m.id, amountCents: m.amountCents,
    title: `${o.auto ? 'Matched' : 'Confirm'} ${formatUsd(m.amountCents)} from ${m.origName || 'an unknown sender'} → ${invoices} (${c.name})`,
    proposal: { movementId: m.id, plan, newIdentity, rmNoteId: o.rmNoteId, proposedBy: o.by },
    reasoning: `${o.reasoning} ${plan.basis}.${newIdentity ? ` ${payer} is added to ${c.name}'s payers.` : ''}`,
    policyRef: 'pol-004', confidence: o.confidence, requiredRole: 'ACCOUNTANT', autoApplied: o.auto,
  });
  ctx.db.workItem.id.update({ ...item, boundariesJson: o.evidenceJson });
  if (o.auto) onPaymentApproved(ctx, item.id);
}

/** Once cash is applied, the exception items raised for it while it was unplaced are closed. */
export function closeCashExceptions(ctx: Ctx, movementId: string, cause: string) {
  for (const w of [...ctx.db.workItem.iter()]) {
    if ((w.kind !== 'UNIDENTIFIED_CASH' && w.kind !== 'UNAPPLIED_CASH') || w.subjectId !== movementId || !OPEN.includes(w.state)) continue;
    ctx.db.workItem.id.update({ ...w, state: 'WITHDRAWN', updatedAt: ctx.timestamp });
    audit(ctx, {
      action: 'TRANSITION', subjectType: 'work_item', subjectId: String(w.id), clientId: w.clientId, workItemId: w.id,
      fromState: w.state, toState: 'WITHDRAWN', detail: `Cash placed: ${cause}`,
    });
  }
}
