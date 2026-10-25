import { SenderError, t } from 'spacetimedb/server';
import { actorOf, audit, requireRole, simDate, type Ctx } from '../context';
import { spacetimedb } from '../schema';

/** Baseline policies payment checking cites. Agents draft new versions; a controller activates them. */
const BASELINE = [
  ['pol-001', 'Apply payments that match quoted invoices or an exact set of open invoices', { when: 'payer verified by account or wallet', then: 'apply automatically' }],
  ['pol-002', 'Short by $50.00 or less: apply in full and book the difference to bank fees (6850)', { when: 'quoted invoices, short <= 5000 cents', then: 'write off to 6850' }],
  ['pol-004', 'Affiliate payments apply to the parent client per the CRM map', { when: 'payer is a mapped affiliate', then: 'apply to parent' }],
  ['pol-005', 'Collect overdue fees from custody cash where the contract allows debits', { when: 'debit clause signed, USD custody covers the overdue invoices', then: 'debit custody, apply to the invoices' }],
  ['pol-006', 'Restrict one lever one step at a time, covered by the contract, after the cure period; never hold more than is owed', { when: 'undisputed invoices overdue, cure period expired', then: 'apply the smallest step; Tier 1, strategic clients and offboarding steps go to a controller' }],
  ['pol-007', 'Send payment reminders and notices without approval', { when: 'invoice overdue or access restricted', then: 'notify the client' }],
  ['pol-008', 'Never force a hedged book to close-only; stop new positions instead', { when: 'client has open hedged positions', then: 'NO_NEW_POSITIONS, not CLOSE_ONLY' }],
  ['pol-011', 'Release holds automatically once nothing is overdue', { when: 'matched payment clears overdue', then: 'release hold, restore withdrawals' }],
  ['pol-012', 'Overpayments are held as credit on account', { when: 'payment exceeds quoted invoices', then: 'apply, credit the excess' }],
  ['pol-013', 'Duplicate payments are refunded to the account they came from', { when: 'quoted invoices already paid by an identical wire', then: 'refund through the bank automatically' }],
  ['pol-015', 'Returned payments reverse their applications and reopen the invoices', { when: 'bank returns a payment', then: 'reverse applications' }],
  ['pol-016', 'Correct a books break without approval when the evidence explains it to the cent', { when: 'an adjusting entry closes every unexplained difference exactly, never touches cash, confidence 0.8+', then: 'post it; anything partial goes to a controller' }],
  ['pol-020', "Downgrade a client's tier on score or exploit flag, with controller approval", { when: 'formula tier worse than current, or an exploit flag', then: 'propose up to two steps down to a controller' }],
  ['pol-021', "Upgrade a client's tier one step at a time, with controller approval", { when: 'reliability clears the band line by 3+ points, no recent_late flag', then: 'propose one step up to a controller' }],
  ['pol-022', "Strategic clients' tiers change only by a person; the agent may request a review", { when: 'strategic client, formula tier worse than current', then: 'propose a review, never a tier change' }],
] as const;

export function seedBaselinePolicies(ctx: Ctx) {
  for (const [policyId, title, rule] of BASELINE) {
    const key = `${policyId}@1`;
    if (ctx.db.policy.key.find(key)) continue;
    ctx.db.policy.insert({
      key, policyId, version: 1, status: 'active', title, ruleJson: JSON.stringify(rule), learnedFrom: 'baseline',
      approvedBy: 'owner',
    });
  }
}

/**
 * Agents draft policies; only a controller or admin can set one active. An agent
 * writes `draft` rows only, and never over a version that is already past draft.
 */
export const upsertPolicy = spacetimedb.reducer(
  {
    policyId: t.string(), version: t.u32(), status: t.string(), title: t.string(), ruleJson: t.string(),
    learnedFrom: t.string(), approvedBy: t.string().optional(),
  },
  (ctx, args) => {
    const role = requireRole(ctx, ['AGENT', 'CONTROLLER', 'ADMIN']);
    const row = { key: `${args.policyId}@${args.version}`, ...args, approvedBy: args.approvedBy };
    const before = ctx.db.policy.key.find(row.key);
    if (role === 'AGENT') {
      if (args.status !== 'draft') throw new SenderError('agents may only save drafts; a controller activates them');
      if (before && before.status !== 'draft') throw new SenderError(`${row.key} is ${before.status}; draft a new version`);
      row.approvedBy = undefined;
    }
    if (before) ctx.db.policy.key.update(row);
    else ctx.db.policy.insert(row);
    audit(ctx, { action: 'POLICY_SAVED', subjectType: 'policy', subjectId: row.key, toState: args.status, detail: args.title });
  },
);

function ruleOf(json: string): Record<string, unknown> {
  try {
    const rule = JSON.parse(json);
    return rule && typeof rule === 'object' && !Array.isArray(rule) ? rule : {};
  } catch {
    return {};
  }
}

/**
 * Approved POLICY_DRAFT: the drafted version becomes active from today and the
 * previously active version of the same policy id is superseded. A draft that is
 * gone or no longer a draft is refused quietly (audited). Returns whether it ran.
 */
export function activatePolicyDraft(ctx: Ctx, workItemId: bigint): boolean {
  const item = ctx.db.workItem.id.find(workItemId);
  if (!item) return false;
  const key = String((JSON.parse(item.proposalJson) as { policy_key?: string }).policy_key ?? '');
  const draft = key ? ctx.db.policy.key.find(key) : undefined;
  if (!draft || draft.status !== 'draft') {
    audit(ctx, {
      action: 'POLICY_ACTIVATED', subjectType: 'policy', subjectId: key, clientId: item.clientId, workItemId: item.id,
      fromState: draft?.status ?? '', toState: 'active', allowed: false, policyRef: item.policyRef,
      detail: draft ? `${key} is ${draft.status}, not a draft` : `no policy ${key || '(missing key)'}`,
    });
    return false;
  }
  for (const other of [...ctx.db.policy.policyId.filter(draft.policyId)]) {
    if (other.key === draft.key || other.status !== 'active') continue;
    ctx.db.policy.key.update({ ...other, status: 'superseded' });
    audit(ctx, {
      action: 'POLICY_SUPERSEDED', subjectType: 'policy', subjectId: other.key, clientId: item.clientId, workItemId: item.id,
      fromState: 'active', toState: 'superseded', detail: `by ${draft.key}`, policyRef: draft.policyId,
    });
  }
  const rule = { ...ruleOf(draft.ruleJson), effective_on: simDate(ctx), work_item_id: Number(item.id) };
  ctx.db.policy.key.update({
    ...draft, status: 'active', ruleJson: JSON.stringify(rule), approvedBy: actorOf(ctx)?.name || actorOf(ctx)?.role || 'controller',
  });
  audit(ctx, {
    action: 'POLICY_ACTIVATED', subjectType: 'policy', subjectId: draft.key, clientId: item.clientId, workItemId: item.id,
    fromState: 'draft', toState: 'active', detail: `${draft.title} · effective ${rule.effective_on}`, policyRef: draft.policyId,
  });
  return true;
}

/** Rejected POLICY_DRAFT: the drafted version is marked rejected so it is never activated. */
export function rejectPolicyDraft(ctx: Ctx, workItemId: bigint) {
  const item = ctx.db.workItem.id.find(workItemId);
  if (!item) return;
  const key = String((JSON.parse(item.proposalJson) as { policy_key?: string }).policy_key ?? '');
  const draft = key ? ctx.db.policy.key.find(key) : undefined;
  if (!draft || draft.status !== 'draft') return;
  ctx.db.policy.key.update({ ...draft, status: 'rejected' });
  audit(ctx, {
    action: 'POLICY_REJECTED', subjectType: 'policy', subjectId: key, clientId: item.clientId, workItemId: item.id,
    fromState: 'draft', toState: 'rejected', detail: draft.title, policyRef: draft.policyId,
  });
}

/** The work item that activated a policy version, recorded in its rule at activation. */
export function activatingWorkItem(ruleJson: string): number | undefined {
  const id = Number(ruleOf(ruleJson).work_item_id);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}
