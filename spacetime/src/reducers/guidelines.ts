import { SenderError, t } from 'spacetimedb/server';
import { actorOf, audit, requireRole, simDate, type Ctx } from '../context';
import { createWorkItem } from '../payments/apply';
import { spacetimedb } from '../schema';

/**
 * The credit console's levers on the tier guidelines: tier cutoffs and rules, the
 * reliability model's weights, and exploit fixes. Each is a draft policy plus a
 * POLICY_DRAFT work item, so it always waits for a controller (autonomy.ts) and is
 * activated by the existing policy flow (activatePolicyDraft).
 */

/** Policy ids the console drafts; exploit fixes are `exploit-fix-<pattern>`. */
const GUIDELINE_IDS = /^(credit-tiers|credit-model|exploit-fix-[a-z_]+)$/;
const EXPLOIT_FIXES = ['prepay', 'shorter_grace', 'aging_from_first_due', 'verified_payers_only', 'collect_after_dispute'];

export const proposeGuidelineChange = spacetimedb.reducer(
  { policyId: t.string(), title: t.string(), ruleJson: t.string(), reasoning: t.string(), clientId: t.string() },
  (ctx, { policyId, title, ruleJson, reasoning, clientId }) => {
    requireRole(ctx, ['CONTROLLER', 'ADMIN']);
    if (!GUIDELINE_IDS.test(policyId)) throw new SenderError(`not a guideline policy: ${policyId}`);
    if (!title.trim()) throw new SenderError('give the change a title');
    if (!reasoning.trim()) throw new SenderError('give the reasoning for the change');
    let rule: Record<string, unknown>;
    try {
      rule = JSON.parse(ruleJson);
    } catch {
      throw new SenderError('ruleJson must be JSON');
    }
    if (policyId.startsWith('exploit-fix-')) {
      const ids = rule.client_ids;
      if (!Array.isArray(ids) || !ids.length) throw new SenderError('an exploit fix names the clients it applies to');
      for (const id of ids) if (!ctx.db.client.id.find(String(id))) throw new SenderError(`unknown client ${id}`);
      if (!EXPLOIT_FIXES.includes(String(rule.fix))) throw new SenderError(`unknown fix ${String(rule.fix)}`);
    }
    if (clientId && !ctx.db.client.id.find(clientId)) throw new SenderError(`unknown client ${clientId}`);

    const versions = [...ctx.db.policy.policyId.filter(policyId)].map((p) => p.version);
    const version = (versions.length ? Math.max(...versions) : 0) + 1;
    const key = `${policyId}@${version}`;
    const who = actorOf(ctx)?.name || 'controller';
    ctx.db.policy.insert({
      key, policyId, version, status: 'draft', title: title.trim(), ruleJson: JSON.stringify(rule),
      learnedFrom: `console: ${who}`, approvedBy: undefined,
    });
    audit(ctx, { action: 'POLICY_SAVED', subjectType: 'policy', subjectId: key, clientId, toState: 'draft', detail: title.trim() });
    // POLICY_DRAFT always waits for a person, so the proposer's colleague approves it.
    createWorkItem(ctx, {
      kind: 'POLICY_DRAFT', clientId, subjectId: `policy:${key}`, amountCents: 0n, title: title.trim(),
      proposal: { policy_key: key, decided_by: who, rule }, reasoning: reasoning.trim(), policyRef: policyId,
      confidence: 1, requiredRole: 'CONTROLLER', autoApplied: false,
    });
  },
);

/**
 * Approved exploit fix: what it does to the clients it names. Runs after the draft is
 * activated. Only `prepay` touches access (new usage moves to prepay); the others
 * change how the agent treats those clients from now on and are read from the policy.
 */
export function applyGuidelineEffects(ctx: Ctx, workItemId: bigint) {
  const item = ctx.db.workItem.id.find(workItemId);
  if (!item || item.kind !== 'POLICY_DRAFT') return;
  const p = JSON.parse(item.proposalJson) as { policy_key?: string; rule?: { fix?: string; client_ids?: string[]; pattern?: string } };
  if (!p.policy_key?.startsWith('exploit-fix-') || p.rule?.fix !== 'prepay') return;
  for (const id of p.rule.client_ids ?? []) {
    const c = ctx.db.client.id.find(id);
    if (!c || c.status === 'prepay') continue;
    ctx.db.client.id.update({ ...c, status: 'prepay' });
    const api = ctx.db.accessLever.id.find(`${id}:api`);
    if (api && api.state === 'active') {
      ctx.db.accessLever.id.update({ ...api, state: 'limited', detail: 'Prepay required', workItemId: item.id });
    }
    audit(ctx, {
      action: 'LEVER_SET', subjectType: 'client', subjectId: id, clientId: id, workItemId: item.id,
      fromState: c.status, toState: 'prepay', detail: `Exploit fix (${p.rule.pattern ?? 'pattern'}): new usage on prepay`,
      policyRef: p.policy_key,
    });
  }
}

/** A person marks a client strategic (always handled by a person from then on) or clears it. */
export const setStrategic = spacetimedb.reducer(
  { clientId: t.string(), strategic: t.bool(), reason: t.string() },
  (ctx, { clientId, strategic, reason }) => {
    requireRole(ctx, ['CONTROLLER', 'ADMIN']);
    const c = ctx.db.client.id.find(clientId);
    if (!c) throw new SenderError(`unknown client ${clientId}`);
    if (!reason.trim()) throw new SenderError('give a reason');
    if (c.strategic === strategic) return;
    ctx.db.client.id.update({ ...c, strategic });
    audit(ctx, {
      action: 'STRATEGIC_SET', subjectType: 'client', subjectId: clientId, clientId,
      fromState: String(c.strategic), toState: String(strategic), detail: reason.trim(),
    });
    recordPrecedent(ctx, clientId, `${c.name} ${strategic ? 'marked' : 'unmarked'} strategic`, strategic ? 'Mark strategic' : 'Clear strategic', reason.trim());
  },
);

/** Any other human call in the credit console (an exploit dismissed, a move kept) becomes a precedent. */
export const recordConsolePrecedent = spacetimedb.reducer(
  { clientId: t.string(), situation: t.string(), decision: t.string(), reason: t.string() },
  (ctx, { clientId, situation, decision, reason }) => {
    requireRole(ctx, ['CONTROLLER', 'ADMIN']);
    if (!situation.trim() || !decision.trim()) throw new SenderError('describe the situation and the decision');
    if (!reason.trim()) throw new SenderError('give a reason');
    recordPrecedent(ctx, clientId, situation.trim(), decision.trim(), reason.trim());
  },
);

function recordPrecedent(ctx: Ctx, clientId: string, situation: string, decision: string, reason: string) {
  const n = [...ctx.db.precedent.iter()].filter((p) => p.id.startsWith('PRC-C')).length + 1;
  ctx.db.precedent.insert({
    id: `PRC-C${n}`, clientId, workItemId: undefined, decidedOn: simDate(ctx), situation, proposed: '',
    decision, overrideReason: reason, outcome: '', policyRef: 'console', source: 'live',
  });
  audit(ctx, { action: 'PRECEDENT', subjectType: 'precedent', subjectId: `PRC-C${n}`, clientId, detail: `${decision}: ${reason}` });
}
