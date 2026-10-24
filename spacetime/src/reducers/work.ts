import { SenderError, t } from 'spacetimedb/server';
import { actorOf, audit, requireRole } from '../context';
import { isGoverned, needsHuman } from '../autonomy';
import { CAN_APPROVE, CAN_POST, type Role } from '../roles';
import { spacetimedb } from '../schema';
import { canTransition, type WorkItemState } from '../workflow';
import { executeApproved } from './actions';
import { recordCreditPrecedent } from './credit';
import { onPaymentApproved } from './payments';

export const proposeWorkItem = spacetimedb.reducer(
  {
    kind: t.string(),
    clientId: t.string(),
    subjectId: t.string(),
    title: t.string(),
    amountCents: t.i64(),
    proposalJson: t.string(),
    reasoning: t.string(),
    policyRef: t.string(),
    clausesCited: t.array(t.string()),
    boundariesJson: t.string(),
    confidence: t.f32(),
    requiredRole: t.string(),
  },
  (ctx, args) => {
    requireRole(ctx, ['AGENT', 'SYNC', 'ADMIN']);
    // Credit proposals for tier 3 to 5 clients apply on their own unless they are a worst case
    // (autonomy.ts); everything for tier 1 and 2 clients waits for a controller.
    const client = ctx.db.client.id.find(args.clientId);
    let reason: string | undefined = 'unknown client';
    if (client) {
      reason = needsHuman({
        kind: args.kind, tier: client.tier, strategic: client.strategic, confidence: args.confidence,
        proposal: safeJson(args.proposalJson),
      });
    }
    const auto = isGoverned(args.kind) && args.requiredRole === 'CONTROLLER' && reason === undefined;
    const state = auto ? 'APPROVED' : 'PROPOSED';
    const item = ctx.db.workItem.insert({
      id: 0n,
      ...args,
      state,
      autoApplied: auto,
      proposedBy: ctx.sender,
      revision: 1,
      revisedFrom: undefined,
      expiresOn: undefined,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    const why = isGoverned(args.kind) ? (auto ? `auto-approved: tier ${client?.tier} client, a regular case` : `needs a person: ${reason}`) : '';
    audit(ctx, {
      action: auto ? 'AUTO_APPLIED' : 'PROPOSE', subjectType: 'work_item', subjectId: String(item.id), clientId: args.clientId,
      workItemId: item.id, fromState: 'NEW', toState: state, detail: why ? `${args.title} · ${why}` : args.title,
      policyRef: args.policyRef,
    });
    if (auto) executeApproved(ctx, item.id);
  },
);

function safeJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/**
 * The only way a work item changes state. Checks the transition, the caller's
 * role and separation of duties; logs allowed and denied attempts alike.
 */
export const transitionWorkItem = spacetimedb.reducer(
  { workItemId: t.u64(), toState: t.string(), note: t.string() },
  (ctx, { workItemId, toState, note }) => {
    const item = ctx.db.workItem.id.find(workItemId);
    if (!item) throw new SenderError(`work item ${workItemId} not found`);

    const role = actorOf(ctx)?.role as Role | undefined;
    const from = item.state as WorkItemState;
    const to = toState as WorkItemState;

    let denial: string | undefined;
    if (!role) denial = 'caller has no registered role';
    else if (!canTransition(from, to)) denial = `illegal transition ${from} -> ${to}`;
    else if (to === 'APPROVED' && !CAN_APPROVE.includes(role)) denial = `${role} cannot approve`;
    else if (to === 'APPROVED' && item.requiredRole === 'CONTROLLER' && role !== 'CONTROLLER') denial = 'needs a controller';
    else if (to === 'APPROVED' && item.proposedBy.isEqual(ctx.sender)) denial = 'no self-approval';
    else if (to === 'POSTED' && !CAN_POST.includes(role)) denial = 'only the gateway posts';

    audit(ctx, {
      action: 'TRANSITION', subjectType: 'work_item', subjectId: String(item.id), clientId: item.clientId,
      workItemId: item.id, fromState: from, toState: to, allowed: !denial, detail: denial ?? note, policyRef: item.policyRef,
    });

    // Denied attempts return instead of throwing so the audit row still commits.
    if (denial) return;
    ctx.db.workItem.id.update({ ...item, state: to, updatedAt: ctx.timestamp });
    if (to === 'APPROVED') {
      onPaymentApproved(ctx, item.id);
      executeApproved(ctx, item.id);
    }
    if (to === 'REJECTED') recordCreditPrecedent(ctx, item.id, 'Rejected', note);
  },
);
