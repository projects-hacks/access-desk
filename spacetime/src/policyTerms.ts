import { addDays, audit, type Ctx } from './context';
import { createWorkItem } from './payments/apply';
import { defaultedInvoices } from './payments/deadlines';
import { formatUsd } from './payments/match';
import { executeApproved } from './reducers/actions';

/**
 * What a client's own policy says the desk should do, done. Agents draft these policies
 * and Iris grades them against payments; this is where their terms take effect:
 * a reminder N days before each due date, and prepay. Terms marked for renewal wait for it.
 */

interface Term { lever: string; value: number | null; at_renewal: boolean }

/** The client's active own policies with their terms (keys like "pol-020:ORG-1@2"). */
function activeClientPolicies(ctx: Ctx) {
  return [...ctx.db.policy.iter()]
    .filter((p) => p.status === 'active' && p.policyId.includes(':'))
    .map((p) => {
      const rule = JSON.parse(p.ruleJson) as { client_id?: string; terms?: Term[]; effective_on?: string };
      return { key: p.key, policyId: p.policyId, title: p.title, clientId: rule.client_id ?? p.policyId.split(':')[1]!, terms: rule.terms ?? [], effectiveOn: rule.effective_on ?? '' };
    });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/**
 * Each business day: every reminder a client's policy promises, once per invoice, sent the
 * same way as any notice (pol-007, no approval). A client already in default gets the default
 * notice instead, so a reminder never stands in for it or starts a cure period.
 */
export function sendPolicyReminders(ctx: Ctx, today: string) {
  for (const p of activeClientPolicies(ctx)) {
    const reminder = p.terms.find((t) => t.lever === 'reminder' && !t.at_renewal && (t.value ?? 0) > 0);
    if (!reminder || (p.effectiveOn && p.effectiveOn > today)) continue;
    const c = ctx.db.client.id.find(p.clientId);
    if (!c || defaultedInvoices(ctx, c.id, today).length) continue;
    const horizon = addDays(today, reminder.value!);
    for (const inv of ctx.db.invoice.clientId.filter(c.id)) {
      if (inv.paidCents >= inv.amountCents || inv.status === 'void' || inv.status === 'disputed') continue;
      if (inv.dueOn <= today || inv.dueOn > horizon) continue;
      const subjectId = `reminder:${inv.id}`;
      if ([...ctx.db.workItem.clientId.filter(c.id)].some((w) => w.kind === 'REMINDER' && w.subjectId === subjectId)) continue;
      const owed = inv.amountCents - inv.paidCents;
      const body = `Reminder: ${inv.id} for ${formatUsd(owed)} is due on ${day(inv.dueOn)}. Paying by then keeps your account in good standing.`;
      const item = createWorkItem(ctx, {
        kind: 'REMINDER', clientId: c.id, subjectId, amountCents: owed, title: `Reminder to ${c.name} before ${inv.id} is due`,
        proposal: { channel: 'email', body, policy_key: p.key }, policyRef: p.policyId,
        reasoning: `- ${c.name}'s own policy "${p.title}" sends a reminder ${reminder.value} days before each due date.\n- ${inv.id} is due ${day(inv.dueOn)}.`,
        confidence: 1, requiredRole: 'CONTROLLER', autoApplied: true,
      });
      executeApproved(ctx, item.id);
    }
  }
}

/** Moves a client to prepay for new usage: the client row and its API access say so. */
export function moveToPrepay(ctx: Ctx, clientId: string, workItemId: bigint, why: string, policyRef: string) {
  const c = ctx.db.client.id.find(clientId);
  if (!c || c.status === 'prepay') return;
  ctx.db.client.id.update({ ...c, status: 'prepay' });
  const api = ctx.db.accessLever.id.find(`${clientId}:api`);
  if (api && api.state === 'active') ctx.db.accessLever.id.update({ ...api, state: 'limited', detail: 'Prepay required', workItemId });
  audit(ctx, {
    action: 'LEVER_SET', subjectType: 'client', subjectId: clientId, clientId, workItemId,
    fromState: c.status, toState: 'prepay', detail: why, policyRef,
  });
}

/** A client policy just put in force: its prepay term applies now; reminders run daily. */
export function applyPolicyTerms(ctx: Ctx, policyKey: string, workItemId: bigint) {
  const p = activeClientPolicies(ctx).find((x) => x.key === policyKey);
  if (!p?.terms.some((t) => t.lever === 'prepay' && !t.at_renewal)) return;
  moveToPrepay(ctx, p.clientId, workItemId, `${p.title}: new usage on prepay`, p.policyId);
}

/** Active policies whose prepay never took effect (they were put in force before this existed). */
export function catchUpPrepay(ctx: Ctx) {
  for (const p of activeClientPolicies(ctx)) {
    if (!p.terms.some((t) => t.lever === 'prepay' && !t.at_renewal)) continue;
    const c = ctx.db.client.id.find(p.clientId);
    if (!c || c.status !== 'active') continue;
    const activated = Number((JSON.parse(ctx.db.policy.key.find(p.key)!.ruleJson) as { work_item_id?: number }).work_item_id ?? 0);
    moveToPrepay(ctx, c.id, BigInt(activated), `${p.title}: new usage on prepay`, p.policyId);
  }
}
