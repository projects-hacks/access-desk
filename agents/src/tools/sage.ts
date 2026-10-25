import { z } from 'zod';
import { cutoffComparison } from '../access/comparison';
import { addDays, usd, usdShort } from '../access/format';
import { LEVER_PRODUCT, STEP_SHORT, overdueInvoices, owed } from '../access/helpers';
import { dropped, invented } from '../access/notice';
import { custodyDebit, ladders, nextStep } from '../access/plan';
import type { Facts } from './facts';
import type { Actor, Gate } from './gate';
import { plainPoints, words } from './text';
import type { ToolDef } from './toolset';

/** Notices and reasons are short; a notice is at most this many words (the notice rules). */
const NOTICE_WORDS = 120;
const LEVERS = ['withdrawals', 'trading', 'api', 'financing'] as const;
/** Why the desk waits, in the codes the audit log already uses. */
export const WAIT_CODES = [
  'grace_period', 'cure_period', 'awaiting_default_notice', 'payment_in_transit', 'payment_unapplied', 'promise_to_pay', 'approved_exception', 'pending_decision',
  'rm_note_pending', 'controller_rejected', 'escalation_spacing', 'no_further_step', 'gateway_failed', 'other',
] as const;

const reason = z.string().min(5).max(800).describe('Why, as 2 to 4 lines, each starting with "- ", one short plain sentence per line, the way a controller would write it. Amounts as $106,950, dates as Dec 20, "9 invoices" not a list of ids. No codes (no step names, policy ids or section marks), no semicolons, no dashes.');

/** Every number a notice to this client may contain: the facts the desk holds, as text. */
export function noticeFacts(f: Facts): string {
  const v = f.view;
  const parts: string[] = [f.today, f.world.wireInstructions, v.client.name, String(v.contract?.graceDays ?? ''), String(v.contract?.cureDays ?? '')];
  for (const i of v.invoices) {
    parts.push(i.id, i.issuedOn, i.dueOn, usd(i.amountCents), usd(i.amountCents - i.paidCents), usd(i.paidCents), i.paidOn ?? '');
    parts.push(addDays(i.dueOn, v.contract?.graceDays ?? 0), addDays(i.dueOn, (v.contract?.graceDays ?? 0) + 1));
  }
  parts.push(usd(owed(overdueInvoices(v, f.today))), usd(owed(v.invoices.filter((i) => i.paidCents < i.amountCents))));
  for (const m of v.cash) parts.push(m.bankRef, usd(m.amountCents), m.valueOn, ...m.refs);
  for (const h of f.holds) parts.push(usd(h.amountCents), h.clause, ...h.invoiceIds);
  for (const c of v.clauses) parts.push(`§${c.clause}`, c.clause);
  for (const d of v.deadlines) parts.push(d.startedOn, d.dueOn);
  for (const w of v.workItems) parts.push(`WI-${w.id}`, w.amountCents ? usd(w.amountCents) : '');
  for (const n of v.rmNotes) parts.push(`RM-${n.id}`);
  for (const h of v.custody) parts.push(usd(h.valueCents));
  return parts.join(' ');
}

/** Why the notice can't go out, or undefined. `draft` is the rules' own wording, when it has one for the same subject. */
export function checkNotice(text: string, allowed: string, draft?: string): string | undefined {
  if (words(text) > NOTICE_WORDS) return `at most ${NOTICE_WORDS} words, this is ${words(text)}`;
  if (/[[\]{}<>]/.test(text)) return 'no placeholders or markup, write the final text';
  const extra = invented(allowed, text);
  if (extra.length) return `numbers not in the facts: ${extra.join(', ')}. Write amounts, dates and ids exactly as the tools show them`;
  const lost = draft ? dropped(draft, text) : [];
  if (lost.length) return `dropped from the facts: ${lost.join(', ')}. Keep every amount and invoice number`;
  return undefined;
}

/**
 * Sage's action tools. Each makes the same reducer call the rules make, through the task's
 * `attempt`, so a refusal from the database is recorded on the panel and returned to the model
 * as text. At most one succeeds per task (the gate).
 */
export function sageTools(f: Facts, actor: Actor, gate: Gate, draft?: { body: string; tag: string }): ToolDef[] {
  const { view, today, world } = f;
  const { reducers } = actor.conn;
  const clientId = view.client.id;
  const name = view.client.name;
  const ladder = ladders(world.capability);
  const overdue = overdueInvoices(view, today);
  const amount = owed(overdue);
  const unpaidProducts = new Set(overdue.map((i) => i.product));
  const allowedText = noticeFacts(f);
  const proposed = 'The database applies it at once or sends it to a controller, as policy decides.';

  const restrict = async (tool: string, lever: string, step: string, why: string) => {
    const comparison = cutoffComparison(view, lever, step, amount, world.capability, world.policies);
    const isHold = lever === 'withdrawals' && step === 'HOLD_AMOUNT_OWED';
    const what = isHold ? `hold ${usdShort(amount)} of ${name}'s withdrawals` : `${STEP_SHORT[step] ?? step.toLowerCase()} for ${name}`;
    const confidence = isHold || unpaidProducts.has(LEVER_PRODUCT[lever] ?? '') ? 0.9 : 0.75;
    return gate.act(tool, { lever, step }, `done: proposed to ${what}. ${proposed}`, () =>
      actor.attempt(what, () => reducers.proposeRestrictionWithBoundaries({
        clientId, lever, step, reasoning: plainPoints(why), policyRef: 'pol-006', confidence, boundariesJson: JSON.stringify([comparison]),
      })));
  };

  return [
    {
      name: 'hold_amount_owed', readOnly: false, input: { reason },
      description: `ACTION (one per task). Hold the amount past due (${usd(amount)} now) from the client's withdrawals under the set-off clause. The rest of custody stays withdrawable. Needs a set-off right and, if the contract has a cure clause, a finished cure period.`,
      run: async (a) => (overdue.length ? restrict('hold_amount_owed', 'withdrawals', 'HOLD_AMOUNT_OWED', a.reason) : gate.refuse('hold_amount_owed', {}, `${name} has nothing overdue`)),
    },
    {
      name: 'restrict_lever', readOnly: false, input: { lever: z.enum(['trading', 'api', 'financing']), reason },
      description: 'ACTION (one per task). Restrict one lever by ONE step, always the gentlest step not yet taken on that lever (the tool picks it). Use hold_amount_owed for withdrawals.',
      run: async (a) => {
        const step = nextStep(view, a.lever, ladder);
        if (!overdue.length) return gate.refuse('restrict_lever', { lever: a.lever }, `${name} has nothing overdue`);
        if (!step) return gate.refuse('restrict_lever', { lever: a.lever }, `no further step on ${a.lever}: it is not in the contract or every allowed step is already in place`);
        return restrict('restrict_lever', a.lever, step, a.reason);
      },
    },
    {
      name: 'collect_overdue_from_custody', readOnly: false, input: { invoice_ids: z.array(z.string()).optional().describe('Overdue invoices to collect. Default: every overdue invoice USD custody covers, oldest first'), reason },
      description: 'ACTION (one per task). Debit overdue, undisputed invoices from the client\'s USD custody cash. Needs the client\'s debit consent in the contract and enough USD cash.',
      run: async (a) => {
        const auto = custodyDebit(view, today);
        const ids: string[] = a.invoice_ids?.length ? a.invoice_ids : auto?.kind === 'custody_debit' ? auto.invoiceIds : [];
        const total = overdue.filter((i) => ids.includes(i.id)).reduce((s, i) => s + i.amountCents - i.paidCents, 0);
        const what = `debit ${usdShort(total || amount)} from ${name}'s custody`;
        return gate.act('collect_overdue_from_custody', { invoiceIds: ids }, `done: proposed to ${what}. ${proposed}`, () =>
          actor.attempt(what, () => reducers.proposeCustodyDebit({ clientId, invoiceIds: ids, reasoning: plainPoints(a.reason), policyRef: 'pol-005', confidence: 0.9 })));
      },
    },
    {
      name: 'send_notice', readOnly: false,
      input: {
        channel: z.enum(['email', 'portal', 'rm']).describe('email or portal to the client, rm to the relationship manager (an internal colleague)'),
        text: z.string().min(10).describe(`The notice. Plain text, at most ${NOTICE_WORDS} words, no greeting, no signature, no placeholders. Copy amounts, dates and invoice numbers exactly as the tools show them. Add no number that is not in the facts.`),
        about_work_item: z.number().int().optional().describe('The work item number (WI-n) this tells the client about. Pass it when telling the client about a restriction or restore, or the desk thinks nobody was told.'),
        about_rm_note: z.number().int().optional().describe('The RM note number you are replying to. Pass it when answering an RM note, or the desk thinks it is unanswered.'),
        reason,
      },
      description: 'ACTION (one per task). Send a notice to the client or the relationship manager. The wording must pass the desk\'s number check: every amount, date and id comes from the facts.',
      run: async (a) => {
        if (a.about_work_item !== undefined && a.about_rm_note !== undefined) return gate.refuse('send_notice', {}, 'pass either about_work_item or about_rm_note, not both');
        // The default notice starts the contract's cure period; the database sends it on schedule, once.
        if (/\bdefault notice\b|\bnotice of default\b|\bin default\b/i.test(a.text) && a.about_work_item === undefined && a.about_rm_note === undefined) {
          return gate.refuse('send_notice', { channel: a.channel }, 'the desk sends the default notice itself on schedule. Send reminders, replies to the RM, or notices about a restriction or restore');
        }
        if (a.about_work_item !== undefined && !view.workItems.some((w) => w.id === a.about_work_item)) return gate.refuse('send_notice', {}, `this client has no work item ${a.about_work_item}`);
        if (a.about_rm_note !== undefined && !view.rmNotes.some((n) => n.id === a.about_rm_note)) return gate.refuse('send_notice', {}, `this client has no RM note ${a.about_rm_note}`);
        const tag = a.about_work_item !== undefined ? `(ref WI-${a.about_work_item})` : a.about_rm_note !== undefined ? `(re RM-${a.about_rm_note})` : '';
        const text = a.text.trim();
        const problem = checkNotice(text, allowedText, draft && tag && draft.tag === tag ? draft.body : undefined);
        if (problem) return gate.refuse('send_notice', { channel: a.channel }, problem);
        const what = `notice to ${name}`;
        return gate.act('send_notice', { channel: a.channel, about: tag }, `done: ${a.channel === 'rm' ? 'reply sent to the RM' : 'notice sent'}. ${proposed}`, () =>
          actor.attempt(what, () => reducers.proposeNotice({
            clientId, channel: a.channel, body: tag ? `${text} ${tag}` : text, reasoning: plainPoints(a.reason), policyRef: 'pol-007', confidence: tag.startsWith('(ref') ? 0.95 : 0.9,
          })));
      },
    },
    {
      name: 'restore_lever', readOnly: false, input: { lever: z.enum(LEVERS), reason },
      description: 'ACTION (one per task). Give back access on one restricted lever (releases holds on withdrawals). Only for a lever that is restricted now.',
      run: async (a) => {
        const what = `restore ${name}'s ${a.lever}`;
        return gate.act('restore_lever', { lever: a.lever }, `done: proposed to ${what}. ${proposed}`, () =>
          actor.attempt(what, () => reducers.proposeRestore({ clientId, lever: a.lever, reasoning: plainPoints(a.reason), policyRef: 'pol-011', confidence: 0.95 })));
      },
    },
    {
      name: 'hold_off', readOnly: false,
      input: { code: z.enum(WAIT_CODES).describe('Why the desk waits'), reason },
      description: 'ACTION (one per task). Decide not to act now and record why in the audit log. Use it when the right move is to wait.',
      run: async (a) => {
        const why = plainPoints(a.reason);
        return gate.act('hold_off', { code: a.code }, 'done: the wait is recorded in the audit log.', () =>
          actor.attempt(`record why ${name} was not acted on`, () => reducers.recordWait({ clientId, code: a.code, reason: why })));
      },
    },
  ];
}
