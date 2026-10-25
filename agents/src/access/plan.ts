import { agreedLevers, notePending, rmReply, unappliedCash } from './cases';
import { cutoffComparison } from './comparison';
import { addDays, capitalize, listed, usd, usdShort } from './format';
import {
  EXECUTED_KINDS, LEVER_PRODUCT, LEVER_WORDS, OPEN, OUR_KINDS, PROPOSAL_WORDS, STEP_SHORT, STEP_WORDS, allowed, cite, clause, defaultedInvoices, graceDays, hedged, ids,
  latestDeadline, overdueInvoices, owed, proposalOf, rejectedSince, usdCash,
} from './helpers';
import type { CapabilityRow, ClientView, InvoiceRow, LeverRow, Move, NoticeMove, Plan, Wait, World } from './model';
import { precedentsDue } from './precedents';

/** Recover first, restrict the unpaid product first, gentlest step first; restore on payment. */

export const ESCALATION_DAYS = Number(process.env.ESCALATION_DAYS ?? 7);
const NEVER_PROPOSED = new Set(['FEE_DEBIT', 'FULL_FREEZE']);
const DETAIL_STEP: Record<string, string> = {
  'Prepay required': 'REQUIRE_PREPAY', 'Read-only': 'READ_ONLY', 'OTC paused': 'PAUSE_OTC', 'Close-only': 'CLOSE_ONLY',
  'No new borrowing': 'NO_NEW_BORROWING', 'Credit line lowered': 'LOWER_LINE',
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The lever ladders, gentlest step first. */
export function ladders(capability: CapabilityRow[]): Record<string, string[]> {
  const out: Record<string, CapabilityRow[]> = {};
  for (const c of capability) (out[c.lever] ??= []).push(c);
  return Object.fromEntries(Object.entries(out).map(([lever, rows]) => [lever, rows.sort((a, b) => a.gentleness - b.gentleness).map((c) => c.step)]));
}

/** Bookkeeping (precedents, investigations), then at most one decision, or a wait to record. */
export function plan(v: ClientView, world: World, ladder: Record<string, string[]>, escalationDays = ESCALATION_DAYS): Plan {
  const bookkeeping = [...precedentsDue(v, world.today), ...investigationsDue(v, world)];
  const next = nextMove(v, world, ladder, escalationDays);
  if (!next) return { bookkeeping };
  if (!('code' in next)) return { bookkeeping, decision: next };
  return { bookkeeping, wait: next, recordWait: world.lastWait !== next.reason };
}

export function nextMove(v: ClientView, world: World, ladder: Record<string, string[]>, escalationDays: number): Move | Wait | undefined {
  const today = world.today;
  const overdue = overdueInvoices(v, today);
  const reply = rmReply(v, world);
  if (reply) return reply;
  const note = notePending(v, world);
  if (note) return overdue.length ? note : undefined;

  const pending = openWork(v, world);
  if (pending) return overdue.length ? pending : undefined;

  const notice = noticeOwed(v, world);
  if (notice) return notice;

  const holdOff = waiting(v, today, escalationDays);
  const debitRejected = overdue.length ? rejectedSince(v, overdue[0]!.dueOn, 'CUSTODY_DEBIT') : undefined;
  if (overdue.length && !holdOff && !debitRejected) {
    const debit = custodyDebit(v, today);
    if (debit) return debit;
  }

  const defaulted = defaultedInvoices(v, today);
  if (!defaulted.length) {
    const restored = restore(v);
    if (restored || !overdue.length) return restored;
    const grace = graceDays(v);
    return {
      code: 'grace_period',
      reason: `${usd(owed(overdue))} overdue on ${ids(overdue)} but inside the ${grace}-day grace period (in default from ${addDays(overdue[0]!.dueOn, grace + 1)}). ${noDebit(v, holdOff, debitRejected)}`,
    };
  }
  if (holdOff) return holdOff;

  const episode = episodeStart(v, defaulted);
  const cure = latestDeadline(v, 'cure_period');
  if (cureBlocks(v)) {
    if (cure?.status === 'open') {
      return { code: 'cure_period', reason: `${usd(owed(defaulted))} in default, but the cure period${cite(v, 'cure')} runs until ${cure.dueOn} after the default notice of ${cure.startedOn}; restricting before then breaches the contract.` };
    }
    return { code: 'awaiting_default_notice', reason: `${usd(owed(defaulted))} in default on ${ids(defaulted)}; no default notice has gone out yet, so the cure period${cite(v, 'cure')} has not started (pol-007 sends it).` };
  }
  const rejected = rejectedSince(v, episode, 'RESTRICTION');
  if (rejected) {
    const why = rejected.detail ? `: “${rejected.detail}”` : '';
    return { code: 'controller_rejected', reason: `A controller rejected a restriction on ${rejected.simDate}${why}. Not escalating again until the client cures.` };
  }
  return restriction(v, today, ladder, escalationDays, world, agreedLevers(v, episode));
}

/** Something the agent proposed is with a person or the gateway: nothing new until it lands. */
function openWork(v: ClientView, world: World): Wait | undefined {
  for (const w of [...v.workItems].sort((a, b) => a.id - b.id)) {
    if (!OUR_KINDS.has(w.kind)) continue;
    if (OPEN.has(w.state)) {
      return { code: 'pending_decision', reason: `${w.kind.replace(/_/g, ' ').toLowerCase()} WI-${w.id} is waiting for a ${w.requiredRole.toLowerCase()}: ${w.title}.` };
    }
    if (w.state === 'APPROVED' && EXECUTED_KINDS.has(w.kind)) {
      const error = world.failedCommands.get(w.id);
      if (error !== undefined) {
        return { code: 'gateway_failed', reason: `WI-${w.id} (${w.title}) was approved but the gateway could not execute it${error ? `: ${error}` : ''}. A person needs to retry or cancel it.` };
      }
      return { code: 'pending_decision', reason: `WI-${w.id} (${w.title}) is approved and executing through the gateway.` };
    }
  }
  return undefined;
}

/** Money or a promise on the way: don't collect or restrict. */
function waiting(v: ClientView, today: string, escalationDays: number): Wait | undefined {
  const m = v.inTransit[0];
  if (m) return { code: 'payment_in_transit', reason: `${usd(m.amountCents)} ${m.rail} ${m.bankRef} from ${m.origName} was sent ${m.valueOn} and has not posted; acting only on posted funds.` };
  const unapplied = unappliedCash(v)[0];
  if (unapplied) {
    return { code: 'payment_unapplied', reason: `${usd(unapplied.amountCents)} ${unapplied.rail} ${unapplied.bankRef} from ${unapplied.origName} arrived ${unapplied.valueOn} and is not applied yet (${unapplied.matchStatus}); not collecting or restricting until it is.` };
  }
  const match = v.workItems.find((w) => w.kind === 'PAYMENT_MATCH' && OPEN.has(w.state));
  if (match) return { code: 'payment_unapplied', reason: `Payment match WI-${match.id} is waiting for a ${match.requiredRole.toLowerCase()}: ${match.title}.` };
  const promise = v.deadlines.find((d) => d.kind === 'promise_to_pay' && d.status === 'open');
  if (promise) return { code: 'promise_to_pay', reason: `Promise to pay by ${promise.dueOn}${promise.note ? ` (${promise.note})` : ''}.` };
  const until = graceUntil(v, today, escalationDays);
  if (until) return { code: 'approved_exception', reason: `A controller approved an exception; holding off until ${until}.` };
  return undefined;
}

function noDebit(v: ClientView, holdOff?: Wait, debitRejected?: { simDate: string }): string {
  if (debitRejected) return `A controller rejected collecting from custody on ${debitRejected.simDate}.`;
  if (holdOff) return `Not collecting from custody: ${holdOff.reason}`;
  if (!allowed(v, 'debit')) return `Custody can't be debited without the client's consent${cite(v, 'debit')}.`;
  return `USD custody of ${usd(usdCash(v))} doesn't cover any overdue invoice.`;
}

function cureBlocks(v: ClientView): boolean {
  if (!allowed(v, 'cure')) return false;
  const cure = latestDeadline(v, 'cure_period');
  return !cure || cure.status !== 'expired';
}

/** When this default began: the default notice if a cure period started, else the day after grace. */
function episodeStart(v: ClientView, defaulted: InvoiceRow[]): string {
  const cure = latestDeadline(v, 'cure_period');
  if (cure && (cure.status === 'open' || cure.status === 'expired')) return cure.startedOn;
  const grace = graceDays(v);
  return defaulted.map((i) => addDays(i.dueOn, grace + 1)).reduce((a, b) => (a < b ? a : b));
}

function escalationClock(v: ClientView, defaulted: InvoiceRow[]): string {
  const cure = latestDeadline(v, 'cure_period');
  return allowed(v, 'cure') && cure ? cure.dueOn : episodeStart(v, defaulted);
}

/** The step a restricted lever is on, from the work item that set it (or its label, for restrictions set before this agent). */
function currentStep(v: ClientView, lever: LeverRow): string | undefined {
  if (lever.state === 'active' || lever.state === 'not_used') return undefined;
  const item = v.workItems.find((w) => w.id === lever.workItemId);
  if (item?.kind === 'RESTRICTION') return proposalOf(item).step ?? undefined;
  if (lever.lever === 'withdrawals') return 'HOLD_AMOUNT_OWED';
  if (lever.detail.startsWith('Rate limited')) return 'RATE_LIMIT';
  if (lever.detail.startsWith('No new positions')) return 'NO_NEW_POSITIONS';
  return DETAIL_STEP[lever.detail] ?? lever.detail;
}

function usableSteps(v: ClientView, lever: string, ladder: Record<string, string[]>): string[] {
  let steps = (ladder[lever] ?? []).filter((s) => !NEVER_PROPOSED.has(s));
  if (!allowed(v, 'prepay')) steps = steps.filter((s) => s !== 'REQUIRE_PREPAY');
  if (lever === 'trading' && hedged(v)) steps = steps.filter((s) => s !== 'CLOSE_ONLY');
  return steps;
}

function restriction(v: ClientView, today: string, ladder: Record<string, string[]>, escalationDays: number, world: World, onlyLevers?: Set<string>): Move | Wait | undefined {
  const overdue = overdueInvoices(v, today);
  if (!overdue.length) return undefined;
  const unpaid = new Set(overdue.map((i) => i.product));
  const cross = !!v.contract?.crossDefault;
  const flagged = v.flags.some((f) => f.status === 'open' && f.pattern === 'withdrawal_during_cure');

  const candidates: { crossDefault: boolean; position: number; group: number; lever: string; step: string }[] = [];
  let rungsInPlace = 0;
  for (const lever of v.levers) {
    const name = lever.lever;
    if (lever.state === 'not_used' || !(name in LEVER_PRODUCT)) continue;
    const steps = usableSteps(v, name, ladder);
    const step = currentStep(v, lever);
    const position = step && steps.includes(step) ? steps.indexOf(step) + 1 : step ? steps.length : 0;
    rungsInPlace += position;
    if (position >= steps.length || (onlyLevers && !onlyLevers.has(name))) continue;
    let group: number;
    if (name === 'withdrawals') {
      if (!allowed(v, 'set_off')) continue;
      group = flagged ? -1 : 1;
    } else if (unpaid.has(LEVER_PRODUCT[name]!)) {
      group = 0;
    } else if (cross) {
      group = 2;
    } else {
      continue;
    }
    candidates.push({ crossDefault: group === 2, position, group, lever: name, step: steps[position]! });
  }

  if (!candidates.length) {
    const why = !Object.keys(ladder).length ? "the platform's capability table is empty, so no restriction step is known"
      : onlyLevers ? `the controller-approved plan limits restrictions to ${[...onlyLevers].sort().join(', ')}, already in place`
      : rungsInPlace ? 'every step the contract and policy allow is already in place'
      : 'the contract gives no lever for the unpaid products (no set-off right, no cross-default)';
    return { code: 'no_further_step', reason: `${usd(owed(overdue))} still past due, but ${why}; escalating needs a person.` };
  }
  const defaulted = defaultedInvoices(v, today);
  const clock = escalationClock(v, defaulted);
  let readyOn = clock;
  let basis = '';
  if (rungsInPlace) {
    const episode = episodeStart(v, defaulted);
    const approved = v.approvals.filter((a) => a.workItemKind === 'RESTRICTION' && a.simDate >= episode).map((a) => a.simDate);
    const last = approved.length ? approved.reduce((a, b) => (a > b ? a : b)) : undefined;
    basis = last && last >= clock
      ? `the last restriction was approved on ${last}`
      : `the cure period ended on ${clock}; the restrictions in place were set before this agent, so when they started is not recorded`;
    readyOn = addDays([clock, ...approved].reduce((a, b) => (a > b ? a : b)), escalationDays);
  }
  if (today < readyOn) {
    return { code: 'escalation_spacing', reason: `A restriction is in place; the next step waits until ${readyOn} (${escalationDays} days after ${basis}), giving the client time to pay.` };
  }

  const chosen = candidates.sort((a, b) => Number(a.crossDefault) - Number(b.crossDefault) || a.position - b.position || a.group - b.group || (a.lever < b.lever ? -1 : 1))[0]!;
  const { lever, step } = chosen;
  const amount = owed(overdue);
  const name = v.client.name;
  const productUnpaid = unpaid.has(LEVER_PRODUCT[lever]!);
  const why = [`${usd(amount)} past due on ${ids(overdue)} (${[...unpaid].sort().join(', ')}).`];
  const cure = latestDeadline(v, 'cure_period');
  if (cure?.status === 'expired') why.push(`Default notice of ${cure.startedOn}; the cure period ended ${cure.dueOn} unpaid${cite(v, 'cure')}.`);
  if (rungsInPlace) why.push(`Still unpaid ${escalationDays}+ days after ${basis}.`);
  if (lever === 'withdrawals') {
    why.push('Hold only the undisputed amount owed under the set-off clause; the rest of custody stays withdrawable.');
    if (flagged) why.push('The client withdrew custody cash during its cure period (exploit flag), so secure the balance first.');
  } else if (!productUnpaid) {
    why.push(`Nothing is overdue on ${lever}; the contract's cross-default clause allows restricting it.`);
  } else {
    why.push(`${lever} is the product that is unpaid; ${step} is the gentlest step not yet taken.`);
  }
  if (lever === 'trading' && hedged(v)) why.push('Open hedged positions: never close-only (pol-008); existing hedges stay intact.');
  const comparison = cutoffComparison(v, lever, step, amount, world.capability, world.policies);
  const decision = why.join(' ');
  why.push(`Compared with a full cutoff: ${comparison.fullCutoff.summary}`);

  const isHold = lever === 'withdrawals' && step === 'HOLD_AMOUNT_OWED';
  const kept = v.levers.filter((l) => l.state !== 'not_used' && l.lever !== lever).map((l) => LEVER_WORDS[l.lever] ?? l.lever);
  const what = isHold ? `hold ${usdShort(amount)} of ${name}'s withdrawals` : `${STEP_SHORT[step] ?? step.toLowerCase()} for ${name}`;
  const lead = rungsInPlace ? `${name} is still unpaid, ${usdShort(amount)} overdue.` : cure?.status === 'expired' ? `${name} missed its cure date with ${usdShort(amount)} overdue.` : `${name} is ${usdShort(amount)} overdue.`;
  const act = isHold ? `Holding the overdue amount${kept.length ? `; ${listed(kept)} stays open` : ''}.` : `${PROPOSAL_WORDS[step] ?? step}.`;
  return {
    kind: 'restriction', lever, step, reasoning: why.join(' '), policyRef: 'pol-006', boundaries: [comparison], confidence: !productUnpaid && lever !== 'withdrawals' ? 0.75 : 0.9,
    summary: what, what, headline: `${lead} ${act}`, why: decision,
  };
}

/** Every overdue invoice USD custody covers, oldest first, in one debit (debits apply without a person). */
function custodyDebit(v: ClientView, today: string): Move | undefined {
  if (!allowed(v, 'debit')) return undefined;
  const overdue = overdueInvoices(v, today);
  const cash = usdCash(v);
  const chosen: InvoiceRow[] = [];
  let total = 0;
  for (const inv of overdue) {
    const due = inv.amountCents - inv.paidCents;
    if (total + due <= cash) {
      chosen.push(inv);
      total += due;
    }
  }
  if (!chosen.length) return undefined;
  let reasoning = `${usd(total)} past due on ${ids(chosen)}. Contract §${clause(v, 'debit')!.clause} allows debiting fees from custody, and USD custody of ${usd(cash)} covers it. Collecting first avoids any restriction.`;
  if (chosen.length < overdue.length) reasoning += ` Custody covers ${chosen.length} of ${overdue.length} overdue invoices; the rest stays in collections.`;
  const name = v.client.name;
  return {
    kind: 'custody_debit', invoiceIds: chosen.map((i) => i.id), reasoning, policyRef: 'pol-005', confidence: 0.9, summary: `debit ${usdShort(total)} from ${name}'s custody`,
    what: `debit ${usdShort(total)} from ${name}'s custody`,
    headline: `${name} is ${usdShort(total)} past due and its custody covers it. Collecting from custody instead of restricting anything.`,
  };
}

/** Nothing in default any more: give back the first restricted lever. */
function restore(v: ClientView): Move | undefined {
  const lever = v.levers.find((l) => l.state === 'limited' || l.state === 'off');
  if (!lever) return undefined;
  const name = v.client.name;
  return {
    kind: 'restore', lever: lever.lever, policyRef: 'pol-011', confidence: 0.95,
    reasoning: `Nothing is in default any more; ${lever.lever} (${lever.detail}) goes back to normal.`,
    summary: `restore ${name}'s ${LEVER_WORDS[lever.lever] ?? lever.lever}`, what: `restore ${name}'s ${LEVER_WORDS[lever.lever] ?? lever.lever}`,
    headline: `${name} is no longer in default. Restoring ${LEVER_WORDS[lever.lever] ?? lever.lever}.`,
  };
}

/** A restriction or restore the gateway has posted, which the client hasn't been told about yet. */
function noticeOwed(v: ClientView, world: World): NoticeMove | undefined {
  const sent = v.workItems.filter((w) => w.kind === 'REMINDER').map((w) => w.proposalJson).join(' ');
  const levers = new Map(v.levers.map((l) => [l.lever, l]));
  for (const item of v.workItems) {
    if ((item.kind !== 'RESTRICTION' && item.kind !== 'RESTORE') || item.state !== 'POSTED') continue;
    const ref = `(ref WI-${item.id})`;
    if (sent.includes(ref)) continue;
    const lever = levers.get(proposalOf(item).lever ?? '');
    const stillRestricted = !!lever && (lever.state === 'limited' || lever.state === 'off');
    if (item.kind === 'RESTRICTION' && (!stillRestricted || !overdueInvoices(v, world.today).length)) continue;
    return {
      kind: 'notice', channel: 'email', body: noticeBody(v, item, world, ref), policyRef: 'pol-007', confidence: 0.95,
      reasoning: `Tell the client what changed on WI-${item.id}, why, and how to restore it.`, summary: `notice to ${v.client.name} about WI-${item.id}`,
    };
  }
  return undefined;
}

function noticeBody(v: ClientView, item: ClientView['workItems'][number], world: World, ref: string): string {
  const p = proposalOf(item);
  const lever: string = p.lever ?? '';
  if (item.kind === 'RESTORE') {
    const others = v.levers.filter((l) => l.lever !== lever && (l.state === 'limited' || l.state === 'off')).map((l) => LEVER_WORDS[l.lever] ?? l.lever);
    const rest = others.length ? ` ${capitalize(listed(others))} ${others.length === 1 ? 'remains' : 'remain'} restricted until the rest is paid.` : ' Your account is fully back to normal.';
    return `Payment received: your access to ${lever === 'api' ? 'the API' : lever} is restored.${rest} Thank you. ${ref}`;
  }
  const overdue = overdueInvoices(v, world.today);
  const action = STEP_WORDS[p.step ?? ''] ?? `restricted ${lever}`;
  return `We have ${action} because ${usd(owed(overdue))} is past due (${ids(overdue)}). Everything else on your account is unchanged. To restore access, pay the amount past due: ${world.wireInstructions}. We restore access once the payment posts. ${ref}`;
}

/** The end date of a controller-approved hold-off (an RM exception request), if still running. */
function graceUntil(v: ClientView, today: string, escalationDays: number): string | undefined {
  const approvedOn = new Map(v.approvals.map((a) => [a.workItemId, a.simDate]));
  for (const item of v.workItems) {
    const on = approvedOn.get(item.id);
    if (item.kind !== 'NOVEL_CASE' || !item.subjectId.startsWith('rm_note:') || on === undefined) continue;
    const proposal = proposalOf(item);
    if (proposal.event) continue;
    const asked = proposal.graceUntil;
    const until = typeof asked === 'string' && ISO_DATE.test(asked) ? asked : addDays(on, escalationDays);
    if (until >= today) return until;
  }
  return undefined;
}

/** A NOVEL_CASE's investigation steps, recorded once on the work item (record_investigation). */
function investigationsDue(v: ClientView, world: World): Move[] {
  const moves: Move[] = [];
  for (const item of v.workItems) {
    if (item.kind !== 'NOVEL_CASE' || world.investigated.has(item.id)) continue;
    const steps: { tool: string; summary: string }[] | undefined = proposalOf(item).investigation;
    if (steps?.length) {
      moves.push({ kind: 'investigation', workItemId: item.id, steps: steps.map((s) => ({ tool: s.tool, summary: s.summary, status: 'done' })), summary: `${steps.length} investigation steps on WI-${item.id}` });
    }
  }
  return moves;
}
