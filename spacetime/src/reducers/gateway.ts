import { SenderError, t } from 'spacetimedb/server';
import { audit, requireRole, type Ctx } from '../context';
import { createWorkItem, recomputeInvoice } from '../payments/apply';
import { CAN_EXECUTE } from '../roles';
import { spacetimedb } from '../schema';

/** Retries before a command is marked failed and escalated. */
const MAX_ATTEMPTS = 5;

interface InvoiceState { id: string; paidCents: number; paidOn: string | null }

/** The gateway takes the next command. Only queued commands can be claimed, so two executors never run one twice. */
export const claimGatewayCommand = spacetimedb.reducer({ id: t.u64() }, (ctx, { id }) => {
  requireRole(ctx, CAN_EXECUTE);
  const cmd = ctx.db.gatewayCommand.id.find(id);
  if (!cmd) throw new SenderError(`command ${id} not found`);
  if (cmd.status !== 'queued') throw new SenderError(`command ${id} is ${cmd.status}`);
  ctx.db.gatewayCommand.id.update({ ...cmd, status: 'executing', attempts: cmd.attempts + 1, updatedAt: ctx.timestamp });
});

/**
 * The system of record accepted the write. Its reported state is applied to
 * the golden copy in the same transaction, so screens don't wait for the next sync.
 */
export const completeGatewayCommand = spacetimedb.reducer(
  { id: t.u64(), resultJson: t.string(), externalRef: t.string().optional() },
  (ctx, { id, resultJson, externalRef }) => {
    requireRole(ctx, CAN_EXECUTE);
    const cmd = ctx.db.gatewayCommand.id.find(id);
    if (!cmd) throw new SenderError(`command ${id} not found`);
    if (cmd.status !== 'executing') throw new SenderError(`command ${id} is ${cmd.status}, not executing`);
    const action = JSON.parse(cmd.actionJson);
    const result = JSON.parse(resultJson);

    switch (cmd.type) {
      case 'APPLY_PAYMENT':
      case 'REVERSE_PAYMENT':
        for (const line of action.applications as { applicationId: string }[]) {
          const app = ctx.db.paymentApplication.id.find(BigInt(line.applicationId));
          if (!app) continue;
          ctx.db.paymentApplication.id.update(cmd.type === 'APPLY_PAYMENT' ? { ...app, posted: true } : { ...app, reversalPosted: true });
        }
        applyInvoiceStates(ctx, result.invoices);
        break;
      case 'CUSTODY_DEBIT':
        applyInvoiceStates(ctx, result.invoices);
        for (const h of result.holdings as { id: string; quantity: number; valueCents: number }[]) {
          const row = ctx.db.custodyHolding.id.find(h.id);
          if (row) ctx.db.custodyHolding.id.update({ ...row, quantity: h.quantity, valueCents: BigInt(h.valueCents) });
        }
        break;
      case 'POST_JOURNAL': {
        const j = action.journal as { journalId: string; postedOn: string; ref: string; memo: string; lines: { account: string; debitCents: string; creditCents: string }[] };
        j.lines.forEach((l, n) => {
          const lineId = `${j.journalId}:${n + 1}`;
          if (ctx.db.ledgerEntry.id.find(lineId)) return;
          ctx.db.ledgerEntry.insert({
            id: lineId, journalId: j.journalId, postedOn: j.postedOn, accountCode: l.account,
            debitCents: BigInt(l.debitCents), creditCents: BigInt(l.creditCents), ref: j.ref, memo: j.memo,
            source: 'access-desk', workItemId: cmd.workItemId,
          });
        });
        break;
      }
      case 'PLACE_HOLD':
      case 'RELEASE_HOLD':
      case 'SET_LEVER': {
        const lever = result.lever as { id: string; state: string; detail: string };
        const row = ctx.db.accessLever.id.find(lever.id);
        if (row) ctx.db.accessLever.id.update({ ...row, state: lever.state, detail: lever.detail });
        break;
      }
      case 'REFUND':
      case 'SEND_NOTICE':
        break;
      default:
        throw new SenderError(`unknown command type ${cmd.type}`);
    }

    ctx.db.gatewayCommand.id.update({ ...cmd, status: 'done', resultJson, externalRef, error: undefined, updatedAt: ctx.timestamp });
    audit(ctx, {
      action: 'COMMAND_DONE', subjectType: 'gateway_command', subjectId: String(id), workItemId: cmd.workItemId,
      fromState: 'executing', toState: 'done', detail: `${cmd.type} ${cmd.key}${externalRef ? ` → ${externalRef}` : ''}`,
    });
  },
);

/** The write failed. Retryable failures go back in the queue; permanent ones are escalated to the controller. */
export const failGatewayCommand = spacetimedb.reducer(
  { id: t.u64(), error: t.string(), retryable: t.bool() },
  (ctx, { id, error, retryable }) => {
    requireRole(ctx, CAN_EXECUTE);
    const cmd = ctx.db.gatewayCommand.id.find(id);
    if (!cmd) throw new SenderError(`command ${id} not found`);
    if (cmd.status !== 'executing') throw new SenderError(`command ${id} is ${cmd.status}, not executing`);
    const retry = retryable && cmd.attempts < MAX_ATTEMPTS;
    ctx.db.gatewayCommand.id.update({ ...cmd, status: retry ? 'queued' : 'failed', error, updatedAt: ctx.timestamp });
    audit(ctx, {
      action: retry ? 'COMMAND_RETRY' : 'COMMAND_FAILED', subjectType: 'gateway_command', subjectId: String(id),
      workItemId: cmd.workItemId, fromState: 'executing', toState: retry ? 'queued' : 'failed', allowed: retry,
      detail: `${cmd.type} ${cmd.key}: ${error}`,
    });
    if (!retry) {
      createWorkItem(ctx, {
        kind: 'SYSTEM_EXCEPTION', clientId: '', subjectId: `gateway_command:${id}`, amountCents: 0n,
        title: `Gateway could not ${cmd.type.toLowerCase().replace(/_/g, ' ')} (${cmd.key})`,
        proposal: { commandId: String(id), error }, reasoning: error, policyRef: '', confidence: 1,
        requiredRole: 'CONTROLLER', autoApplied: false,
      });
    }
  },
);

function applyInvoiceStates(ctx: Ctx, states: InvoiceState[]) {
  for (const s of states) {
    const inv = ctx.db.invoice.id.find(s.id);
    if (!inv) continue;
    ctx.db.invoice.id.update({ ...inv, sourcePaidCents: BigInt(s.paidCents), paidOn: s.paidOn ?? inv.paidOn });
    recomputeInvoice(ctx, s.id);
  }
}
