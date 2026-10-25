import { SenderError, t } from 'spacetimedb/server';
import { audit, requireRole, simDate, type Ctx } from '../context';
import { createWorkItem, recomputeInvoice } from '../payments/apply';
import { startCure } from '../payments/deadlines';
import { CAN_EXECUTE } from '../roles';
import { spacetimedb } from '../schema';
import { route, step } from '../agents';
import { formatUsd } from '../payments/match';
import { LEVER_LABEL } from './actions';

const capitalize = (s: string) => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`;

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
        for (const line of (action.applications ?? []) as { applicationId: string }[]) {
          const app = ctx.db.paymentApplication.id.find(BigInt(line.applicationId));
          if (app) ctx.db.paymentApplication.id.update({ ...app, posted: true });
        }
        applyInvoiceStates(ctx, result.invoices);
        applyHoldings(ctx, result.holdings);
        break;
      case 'CUSTODY_WITHDRAWAL':
        applyHoldings(ctx, result.holdings);
        break;
      case 'TRADE': {
        applyHoldings(ctx, result.holdings);
        const order = ctx.db.tradeOrder.id.find(BigInt(action.orderId));
        if (order) ctx.db.tradeOrder.id.update({ ...order, status: 'filled' });
        break;
      }
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
      case 'SEND_NOTICE': {
        const notice = action.noticeId ? ctx.db.notice.id.find(BigInt(action.noticeId)) : undefined;
        if (notice) {
          // Dated the day it was issued, even if the clock moved before the gateway sent it.
          const sentOn = notice.sentOn ?? simDate(ctx);
          ctx.db.notice.id.update({ ...notice, status: 'sent', sentOn, sentAt: ctx.timestamp });
          // A notice to a client in default starts the contract's cure period.
          if (notice.channel !== 'rm') startCure(ctx, notice.clientId, sentOn, notice.workItemId);
        }
        break;
      }
      case 'REFUND':
        break;
      default:
        throw new SenderError(`unknown command type ${cmd.type}`);
    }

    ctx.db.gatewayCommand.id.update({ ...cmd, status: 'done', resultJson, externalRef, error: undefined, updatedAt: ctx.timestamp });
    audit(ctx, {
      action: 'COMMAND_DONE', subjectType: 'gateway_command', subjectId: String(id), workItemId: cmd.workItemId,
      fromState: 'executing', toState: 'done', detail: `${cmd.type} ${cmd.key}${externalRef ? ` → ${externalRef}` : ''}`,
    });
    const done = gatewayStep(cmd.type, action);
    const clientId = action.clientId ?? (cmd.workItemId !== undefined ? ctx.db.workItem.id.find(cmd.workItemId)?.clientId : undefined);
    if (done) step(ctx, { clientId, actor: 'gateway', text: done, workItemId: cmd.workItemId });
    if (cmd.workItemId !== undefined) postWhenComplete(ctx, cmd.workItemId);
  },
);

/** What the platform or bank now shows, for the agents panel. Journals stay in the books. */
function gatewayStep(type: string, action: { amountCents?: string | number; lever?: string; side?: string; asset?: string; quantity?: number }): string | undefined {
  const amount = action.amountCents !== undefined ? formatUsd(BigInt(action.amountCents)) : '';
  switch (type) {
    case 'PLACE_HOLD': return `Hold of ${amount} written at the platform.`;
    case 'RELEASE_HOLD': return 'Hold lifted at the platform.';
    case 'SET_LEVER': return `${capitalize(LEVER_LABEL[action.lever ?? ''] ?? 'access')} updated at the platform.`;
    case 'CUSTODY_WITHDRAWAL': return `${amount} sent from custody to the client's bank account.`;
    case 'CUSTODY_DEBIT': return `${amount} debited from custody; the invoices are paid.`;
    case 'APPLY_PAYMENT': return 'Payment applied to the invoices on the platform.';
    case 'REVERSE_PAYMENT': return 'Invoices reopened on the platform.';
    case 'REFUND': return `Refund of ${amount} sent back through the bank.`;
    case 'SEND_NOTICE': return 'Notice delivered to the client.';
    case 'TRADE': return `${action.side === 'buy' ? 'Bought' : 'Sold'} ${action.quantity?.toFixed(4)} ${action.asset} for ${amount} at the live price.`;
    default: return undefined;
  }
}

/** An approved work item is POSTED once every command it queued is done. */
function postWhenComplete(ctx: Ctx, workItemId: bigint) {
  const item = ctx.db.workItem.id.find(workItemId);
  if (!item || item.state !== 'APPROVED') return;
  const open = ['queued', 'executing', 'failed'].some((status) =>
    [...ctx.db.gatewayCommand.status.filter(status)].some((c) => c.workItemId === workItemId));
  if (open) return;
  ctx.db.workItem.id.update({ ...item, state: 'POSTED', updatedAt: ctx.timestamp });
  audit(ctx, {
    action: 'TRANSITION', subjectType: 'work_item', subjectId: String(item.id), clientId: item.clientId, workItemId: item.id,
    fromState: 'APPROVED', toState: 'POSTED', detail: 'Every gateway command confirmed', policyRef: item.policyRef,
  });
  if (item.kind === 'RESTRICTION' || item.kind === 'RESTORE') route(ctx, 'posted', item.clientId, `${item.title}: live at the platform`);
}

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
    if (!retry && cmd.type === 'TRADE') {
      const order = ctx.db.tradeOrder.id.find(BigInt(JSON.parse(cmd.actionJson).orderId));
      if (order) ctx.db.tradeOrder.id.update({ ...order, status: 'failed', reason: 'The platform could not fill the order.' });
    }
    if (!retry) {
      createWorkItem(ctx, {
        kind: 'SYSTEM_EXCEPTION', clientId: '', subjectId: `gateway_command:${id}`, amountCents: 0n,
        title: `Gateway could not ${cmd.type.toLowerCase().replace(/_/g, ' ')} (${cmd.key})`,
        proposal: { commandId: String(id), error }, reasoning: error, policyRef: '', confidence: 1,
        requiredRole: 'CONTROLLER', autoApplied: true,
      });
    }
  },
);

function applyHoldings(ctx: Ctx, holdings: { id: string; quantity: number; valueCents: number }[]) {
  for (const h of holdings) {
    const row = ctx.db.custodyHolding.id.find(h.id);
    if (row) ctx.db.custodyHolding.id.update({ ...row, quantity: h.quantity, valueCents: BigInt(h.valueCents) });
  }
}

function applyInvoiceStates(ctx: Ctx, states: InvoiceState[]) {
  for (const s of states) {
    const inv = ctx.db.invoice.id.find(s.id);
    if (!inv) continue;
    ctx.db.invoice.id.update({ ...inv, sourcePaidCents: BigInt(s.paidCents), paidOn: s.paidOn ?? inv.paidOn });
    recomputeInvoice(ctx, s.id);
  }
}
