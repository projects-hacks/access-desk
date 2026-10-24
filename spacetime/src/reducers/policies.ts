import { t } from 'spacetimedb/server';
import { audit, requireRole, type Ctx } from '../context';
import { spacetimedb } from '../schema';

/** Baseline policies payment checking cites. Agents draft new versions; a controller activates them. */
const BASELINE = [
  ['pol-001', 'Apply payments that match quoted invoices or an exact set of open invoices', { when: 'payer verified by account or wallet', then: 'apply automatically' }],
  ['pol-002', 'Short by $50.00 or less: apply in full and book the difference to bank fees (6850)', { when: 'quoted invoices, short <= 5000 cents', then: 'write off to 6850' }],
  ['pol-004', 'Affiliate payments apply to the parent client per the CRM map', { when: 'payer is a mapped affiliate', then: 'apply to parent' }],
  ['pol-005', 'Collect overdue fees from custody cash where the contract allows debits, up to the auto-apply limit', { when: 'debit clause signed, USD custody covers the overdue invoices', then: 'debit custody, apply to the invoices' }],
  ['pol-006', 'Restrict one lever one step at a time, covered by the contract; never hold more than is owed', { when: 'undisputed invoices overdue', then: 'propose the smallest step to a controller' }],
  ['pol-007', 'Send payment reminders and notices without approval', { when: 'invoice overdue or access restricted', then: 'notify the client' }],
  ['pol-008', 'Never force a hedged book to close-only; stop new positions instead', { when: 'client has open hedged positions', then: 'NO_NEW_POSITIONS, not CLOSE_ONLY' }],
  ['pol-011', 'Release holds automatically once nothing is overdue', { when: 'matched payment clears overdue', then: 'release hold, restore withdrawals' }],
  ['pol-012', 'Overpayments are held as credit on account', { when: 'payment exceeds quoted invoices', then: 'apply, credit the excess' }],
  ['pol-013', 'Duplicate payments: hold as unapplied cash and propose a refund', { when: 'quoted invoices already paid', then: 'propose refund to controller' }],
  ['pol-015', 'Returned payments reverse their applications and reopen the invoices', { when: 'bank returns a payment', then: 'reverse applications' }],
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

/** Agents draft policies; only a controller or admin can set one active. */
export const upsertPolicy = spacetimedb.reducer(
  {
    policyId: t.string(), version: t.u32(), status: t.string(), title: t.string(), ruleJson: t.string(),
    learnedFrom: t.string(), approvedBy: t.string().optional(),
  },
  (ctx, args) => {
    const role = requireRole(ctx, ['AGENT', 'CONTROLLER', 'ADMIN']);
    if (args.status === 'active' && role === 'AGENT') requireRole(ctx, ['CONTROLLER', 'ADMIN']);
    const row = { key: `${args.policyId}@${args.version}`, ...args, approvedBy: args.approvedBy };
    if (ctx.db.policy.key.find(row.key)) ctx.db.policy.key.update(row);
    else ctx.db.policy.insert(row);
    audit(ctx, { action: 'POLICY_SAVED', subjectType: 'policy', subjectId: row.key, toState: args.status, detail: args.title });
  },
);
