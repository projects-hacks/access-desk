import { SenderError, t } from 'spacetimedb/server';
import { CAN_APPROVE, CAN_POST, type Role } from '../roles';
import { canTransition, type WorkItemState } from '../workflow';
import { spacetimedb } from '../schema';

export const proposeWorkItem = spacetimedb.reducer(
  {
    kind: t.string(),
    clientId: t.string(),
    summary: t.string(),
    proposalJson: t.string(),
    policyVersion: t.string(),
  },
  (ctx, args) => {
    const item = ctx.db.workItem.insert({
      id: 0n,
      ...args,
      state: 'PROPOSED',
      proposedBy: ctx.sender,
      updatedAt: ctx.timestamp,
    });
    ctx.db.auditEvent.insert({
      id: 0n,
      workItemId: item.id,
      actor: ctx.sender,
      action: 'PROPOSE',
      fromState: 'NEW',
      toState: 'PROPOSED',
      allowed: true,
      detail: args.summary,
      at: ctx.timestamp,
    });
  },
);

/**
 * The only way a work item changes state. Checks the transition, the caller's
 * role and separation of duties; logs allowed and denied attempts alike.
 */
export const transitionWorkItem = spacetimedb.reducer(
  { workItemId: t.u64(), toState: t.string(), note: t.string() },
  (ctx, { workItemId, toState, note }) => {
    const item = ctx.db.workItem.id.find(workItemId);
    if (!item) throw new SenderError(`Work item ${workItemId} not found`);

    const role = ctx.db.actor.identity.find(ctx.sender)?.role as Role | undefined;
    const from = item.state as WorkItemState;
    const to = toState as WorkItemState;

    let denial: string | undefined;
    if (!role) denial = 'caller has no registered role';
    else if (!canTransition(from, to)) denial = `illegal transition ${from} -> ${to}`;
    else if (to === 'APPROVED' && !CAN_APPROVE.includes(role)) denial = `${role} cannot approve`;
    else if (to === 'APPROVED' && item.proposedBy.isEqual(ctx.sender)) denial = 'no self-approval';
    else if (to === 'POSTED' && !CAN_POST.includes(role)) denial = 'only the gateway posts';

    ctx.db.auditEvent.insert({
      id: 0n,
      workItemId,
      actor: ctx.sender,
      action: 'TRANSITION',
      fromState: from,
      toState: to,
      allowed: !denial,
      detail: denial ?? note,
      at: ctx.timestamp,
    });

    // Denied attempts return instead of throwing so the audit row still commits.
    if (denial) return;
    ctx.db.workItem.id.update({ ...item, state: to, updatedAt: ctx.timestamp });
  },
);
