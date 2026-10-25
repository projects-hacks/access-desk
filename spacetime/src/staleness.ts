import { step, wake, type AgentName } from './agents';
import { addDays, audit, type Ctx } from './context';

/** An agent's proposal nobody decided in this many business days is withdrawn and re-decided. */
export const EXPIRE_AFTER_DAYS = 10;

/** Who re-decides each kind of proposal once it expires. */
const OWNER: Record<string, { agent: AgentName; name: string }> = {
  POLICY_DRAFT: { agent: 'scoring', name: 'Quinn' },
  CREDIT_REVIEW: { agent: 'scoring', name: 'Quinn' },
  RESTRICTION: { agent: 'access', name: 'Sage' },
  CUSTODY_DEBIT: { agent: 'access', name: 'Sage' },
  RESTORE: { agent: 'access', name: 'Sage' },
  REMINDER: { agent: 'access', name: 'Sage' },
};

/**
 * Proposals written on old facts don't wait forever: each business day, an agent's proposal left
 * undecided for EXPIRE_AFTER_DAYS is withdrawn (not rejected, so nothing is blocked) and the agent
 * that made it looks again with today's numbers. A person's own proposals never expire.
 */
export function expireStaleProposals(ctx: Ctx, today: string) {
  const cutoff = addDays(today, -EXPIRE_AFTER_DAYS);
  for (const w of [...ctx.db.workItem.iter()]) {
    const owner = OWNER[w.kind];
    if (!owner || (w.state !== 'PROPOSED' && w.state !== 'NEEDS_INFO')) continue;
    if (ctx.db.actor.identity.find(w.proposedBy)?.role !== 'AGENT') continue;
    const proposedOn = [...ctx.db.auditEvent.clientId.filter(w.clientId)].find((e) => e.workItemId === w.id && e.action === 'PROPOSE')?.simDate;
    if (!proposedOn || proposedOn > cutoff) continue;
    ctx.db.workItem.id.update({ ...w, state: 'WITHDRAWN', updatedAt: ctx.timestamp });
    audit(ctx, {
      action: 'TRANSITION', subjectType: 'work_item', subjectId: String(w.id), clientId: w.clientId, workItemId: w.id,
      fromState: w.state, toState: 'WITHDRAWN', detail: `Expired: no decision in ${EXPIRE_AFTER_DAYS} business days`, policyRef: w.policyRef,
    });
    step(ctx, {
      clientId: w.clientId, actor: owner.agent, agent: owner.agent, workItemId: w.id, waiting: false,
      text: `No decision on "${w.title}" in ${EXPIRE_AFTER_DAYS} business days, so it was withdrawn. ${owner.name} will look again with today's numbers.`,
    });
    wake(ctx, owner.agent, w.clientId, `Proposal expired: ${w.title}`);
  }
}
