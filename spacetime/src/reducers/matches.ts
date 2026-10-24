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
    const m = ctx.db.cashMovement.id.find(movementId);
    if (!m) throw new SenderError(`unknown movement ${movementId}`);
    if (m.direction !== 'in' || m.status !== 'posted') throw new SenderError(`${m.bankRef} is not posted incoming cash`);
    if (m.matchStatus !== 'unmatched' && m.matchStatus !== 'exception') throw new SenderError(`${m.bankRef} is ${m.matchStatus}`);
    const c = ctx.db.client.id.find(clientId);
    if (!c) throw new SenderError(`unknown client ${clientId}`);
    const waiting = [...ctx.db.workItem.iter()].find((w) => w.kind === 'PAYMENT_MATCH' && w.subjectId === movementId && OPEN.includes(w.state));
    if (waiting) throw new SenderError(`a match for ${m.bankRef} is already waiting (WI-${waiting.id})`);
    try {
      JSON.parse(evidenceJson);
    } catch {
      throw new SenderError('evidenceJson must be JSON');
    }

    const referenced = m.refs.filter((r) => r.startsWith('INV-'));
    const result = planMatch(m.amountCents, candidates(ctx, clientId), referenced, [], m.chargesCents ?? 0n);
    if (result.kind !== 'plan') {
      throw new SenderError(result.kind === 'none' ? result.reason : `${m.bankRef} pays invoices ${c.name} already paid`);
    }
    const plan = result.plan;
    const known = m.origAccount && [...ctx.db.payerIdentity.value.filter(m.origAccount)].some((p) => p.clientId === clientId);
    const newIdentity = m.origAccount && !known
      ? { kind: 'bank_account', value: m.origAccount, label: `${m.origName} · pays for ${c.name}` }
      : undefined;

    // The agent applies it itself; only below the confidence floor does a person confirm it.
    const auto = !lowConfidence(confidence);
    setMatchStatus(ctx, m.id, 'proposed');
    const invoices = plan.allocations.map((a) => a.invoiceId).join(', ');
    const item = createWorkItem(ctx, {
      kind: 'PAYMENT_MATCH', clientId, subjectId: m.id, amountCents: m.amountCents,
      title: `${auto ? 'Matched' : 'Confirm'} ${formatUsd(m.amountCents)} from ${m.origName} → ${invoices} (${c.name})`,
      proposal: { movementId: m.id, plan, newIdentity, rmNoteId, proposedBy: 'agent' },
      reasoning: `${reasoning} ${plan.basis}.${newIdentity ? ` Account ${m.origAccount} is added to ${c.name}'s payers.` : ''}`,
      policyRef: 'pol-004', confidence, requiredRole: 'ACCOUNTANT', autoApplied: auto,
    });
    ctx.db.workItem.id.update({ ...item, boundariesJson: evidenceJson });
    if (auto) onPaymentApproved(ctx, item.id);
  },
);

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
