import { SenderError, t } from 'spacetimedb/server';
import { audit, requireRole, simDate, type Ctx } from '../context';
import { spacetimedb } from '../schema';
import { activatePolicyDraft, activatingWorkItem, rejectPolicyDraft } from './policies';

/**
 * Seat 1 (credit analyst) writes its scores and exploit flags here. Neither
 * changes access: tier changes are CREDIT_REVIEW work items a controller approves.
 */

const WRITERS = ['AGENT', 'ADMIN'] as const;

/** One row per client. Audited only when a score moves, so the 15 s agent loop stays quiet. */
export const upsertCreditProfile = spacetimedb.reducer(
  {
    clientId: t.string(),
    valueScore: t.u8(),
    reliabilityScore: t.u8(),
    coverageRatio: t.f64(),
    coverageDetail: t.string(),
    expectedSettleOn: t.string().optional(),
  },
  (ctx, args) => {
    requireRole(ctx, WRITERS);
    if (!ctx.db.client.id.find(args.clientId)) throw new SenderError(`unknown client ${args.clientId}`);
    if (args.valueScore > 100 || args.reliabilityScore > 100) throw new SenderError('scores are 0-100');
    const before = ctx.db.creditProfile.clientId.find(args.clientId);
    const row = { ...args, expectedSettleOn: args.expectedSettleOn, updatedAt: ctx.timestamp };
    if (before) ctx.db.creditProfile.clientId.update(row);
    else ctx.db.creditProfile.insert(row);
    if (before && before.valueScore === args.valueScore && before.reliabilityScore === args.reliabilityScore) return;
    audit(ctx, {
      action: 'CREDIT_SCORED', subjectType: 'credit_profile', subjectId: args.clientId, clientId: args.clientId,
      fromState: before ? `reliability ${before.reliabilityScore} · value ${before.valueScore}` : '',
      toState: `reliability ${args.reliabilityScore} · value ${args.valueScore}`,
      detail: `coverage ${args.coverageRatio.toFixed(2)}x · settle ${args.expectedSettleOn ?? 'nothing open'}`,
    });
  },
);

/** Keyed `<pattern>:<client_id>`, so reruns update the same row. A controller's `cleared` sticks. */
export const upsertExploitFlag = spacetimedb.reducer(
  {
    id: t.string(),
    clientId: t.string(),
    pattern: t.string(),
    score: t.f32(),
    status: t.string(),
    months: t.u8(),
    evidenceJson: t.string(),
    proposedFix: t.string(),
  },
  (ctx, args) => {
    requireRole(ctx, WRITERS);
    if (!ctx.db.client.id.find(args.clientId)) throw new SenderError(`unknown client ${args.clientId}`);
    const before = ctx.db.exploitFlag.id.find(args.id);
    if (before) {
      ctx.db.exploitFlag.id.update({ ...args, status: before.status === 'cleared' ? 'cleared' : args.status });
      return;
    }
    ctx.db.exploitFlag.insert(args);
    audit(ctx, {
      action: 'EXPLOIT_FLAGGED', subjectType: 'exploit_flag', subjectId: args.id, clientId: args.clientId,
      toState: args.status, detail: `${args.pattern} · ${args.months} months · score ${args.score.toFixed(2)}`,
    });
  },
);

// ── Decisions on CREDIT_REVIEW items ────────────────────────────────────────

interface CreditProposal { action: 'tier_change' | 'review'; from_tier?: number; to_tier?: number }

interface PolicyDraftProposal { policy_key?: string; decided_by?: string }

/**
 * Every decision on a credit review or policy draft becomes a live precedent;
 * rejections stop the agent re-proposing for 30 sim days. A rejected draft is
 * also marked rejected on the policy table.
 */
export function recordCreditPrecedent(ctx: Ctx, workItemId: bigint, decision: 'Approved' | 'Rejected', overrideReason: string) {
  const item = ctx.db.workItem.id.find(workItemId);
  if (!item || (item.kind !== 'CREDIT_REVIEW' && item.kind !== 'POLICY_DRAFT')) return;
  let proposed: string;
  if (item.kind === 'POLICY_DRAFT') {
    const p = JSON.parse(item.proposalJson) as PolicyDraftProposal;
    proposed = `activate ${p.policy_key ?? item.subjectId}`;
    if (decision === 'Rejected') rejectPolicyDraft(ctx, item.id);
  } else {
    const p = JSON.parse(item.proposalJson) as CreditProposal;
    proposed = p.action === 'tier_change' ? `tier ${p.from_tier} -> ${p.to_tier}` : 'review';
  }
  const decidedBy = (JSON.parse(item.proposalJson) as PolicyDraftProposal).decided_by;
  const before = ctx.db.precedent.id.find(`PRC-L${item.id}`);
  const row = {
    id: `PRC-L${item.id}`, clientId: item.clientId, workItemId: item.id, decidedOn: simDate(ctx),
    situation: decidedBy ? `${item.title} (decided by ${decidedBy})` : item.title,
    proposed, decision, overrideReason, outcome: before?.outcome ?? '', policyRef: item.policyRef, source: 'live',
  };
  if (ctx.db.precedent.id.find(row.id)) ctx.db.precedent.id.update(row);
  else ctx.db.precedent.insert(row);
}

/**
 * Approved CREDIT_REVIEW: a tier change sets client.tier if the client is still
 * on the tier the agent saw; a review only records the decision. Contract grace
 * and cure days stay as signed until renewal.
 */
export function applyCreditReview(ctx: Ctx, workItemId: bigint) {
  const item = ctx.db.workItem.id.find(workItemId);
  if (!item) return;
  const p = JSON.parse(item.proposalJson) as CreditProposal;
  if (p.action === 'tier_change') {
    const c = ctx.db.client.id.find(item.clientId);
    const to = Number(p.to_tier);
    if (!c || c.tier !== p.from_tier || !Number.isInteger(to) || to < 1 || to > 5) {
      // Refused quietly: the item stays approved, the audit row says why nothing changed.
      audit(ctx, {
        action: 'TIER_CHANGED', subjectType: 'client', subjectId: item.clientId, clientId: item.clientId, workItemId: item.id,
        fromState: String(p.from_tier), toState: String(p.to_tier), allowed: false, policyRef: item.policyRef,
        detail: c ? `stale: client is tier ${c.tier}, proposal was from tier ${p.from_tier}` : 'unknown client',
      });
      return;
    }
    ctx.db.client.id.update({ ...c, tier: to });
    audit(ctx, {
      action: 'TIER_CHANGED', subjectType: 'client', subjectId: c.id, clientId: c.id, workItemId: item.id,
      fromState: String(c.tier), toState: String(to), detail: item.title, policyRef: item.policyRef,
    });
  }
  recordCreditPrecedent(ctx, item.id, 'Approved', '');
}

/** Approved POLICY_DRAFT: activate the company's drafted version and record the precedent. */
export function applyPolicyDraft(ctx: Ctx, workItemId: bigint) {
  if (activatePolicyDraft(ctx, workItemId)) recordCreditPrecedent(ctx, workItemId, 'Approved', '');
}

/**
 * The agent's deterministic verdict on an active company policy (`passing on
 * <date>: ...` / `failing on <date>: ...`), stored on the precedent of the
 * approval that activated it. Audited when the verdict changes, not every day.
 */
export const recordPolicyOutcome = spacetimedb.reducer(
  { policyKey: t.string(), outcome: t.string() },
  (ctx, { policyKey, outcome }) => {
    requireRole(ctx, WRITERS);
    const policy = ctx.db.policy.key.find(policyKey);
    if (!policy) throw new SenderError(`unknown policy ${policyKey}`);
    if (policy.status !== 'active') throw new SenderError(`${policyKey} is ${policy.status}, not active`);
    const workItemId = activatingWorkItem(policy.ruleJson);
    const precedent = workItemId ? ctx.db.precedent.id.find(`PRC-L${workItemId}`) : undefined;
    if (!precedent) throw new SenderError(`${policyKey} has no live precedent to record against`);
    if (precedent.outcome === outcome) return;
    ctx.db.precedent.id.update({ ...precedent, outcome });
    const verdict = (s: string) => s.split(' ')[0] ?? '';
    if (verdict(precedent.outcome) === verdict(outcome)) return;
    audit(ctx, {
      action: 'POLICY_OUTCOME', subjectType: 'policy', subjectId: policyKey, clientId: precedent.clientId,
      workItemId: precedent.workItemId, fromState: verdict(precedent.outcome), toState: verdict(outcome),
      detail: outcome, policyRef: policy.policyId,
    });
  },
);
