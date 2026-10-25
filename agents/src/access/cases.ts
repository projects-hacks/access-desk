import { OPEN, allowed, answered, cite, clause, defaultedInvoices, ids, latestDeadline, noteTag, openInvoices, owed, proposalOf, usdCash } from './helpers';
import { bullets, day, listed, plural, sentence, usd, usdShort } from './format';
import type { CaseProposal, CashRow, ClientView, Move, NoticeMove, RmNoteRow, WireEvidence, WorkItemRow, World } from './model';
import { readerName, type RmReading } from './pushback';

/** Everything an RM's note can set off: a check of the bank feed, or a case for a controller. */

const UNAPPLIED = new Set(['unmatched', 'proposed', 'exception']);
const FEE_TOLERANCE_CENTS = 5_000;
const ACTIONABLE = new Set(['already_paid', 'exception_request', 'material_event']);

export const unappliedCash = (v: ClientView): CashRow[] => {
  const open = v.invoices.filter((i) => i.paidCents < i.amountCents);
  if (!open.length) return [];
  const since = open.map((i) => i.issuedOn).reduce((a, b) => (a < b ? a : b));
  return v.cash.filter((m) => m.status === 'posted' && UNAPPLIED.has(m.matchStatus) && m.valueOn >= since);
};

const readBy = (reading?: RmReading) => !!reading?.readBy && `Note read by ${readerName(reading)}.`;
const byId = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);

/** An RM note the agent hasn't read or answered yet: no step and no collection until it has. */
export function notePending(v: ClientView, world: World) {
  for (const note of byId(v.rmNotes)) {
    if (answered(v, note.id)) continue;
    const reading = world.readings.get(note.id);
    if (reading === undefined || ACTIONABLE.has(reading.intent)) {
      const what = reading === undefined ? 'is not read yet' : `(${reading.intent.replace(/_/g, ' ')}) is not answered yet`;
      return { code: 'rm_note_pending', reason: bullets([`RM note ${note.id} from ${note.author} ${what}.`, 'No restriction step or custody debit until it is answered.']) };
    }
  }
  return undefined;
}

export function rmReply(v: ClientView, world: World): Move | undefined {
  for (const note of byId(v.rmNotes)) {
    const reading = world.readings.get(note.id);
    if (reading === undefined || answered(v, note.id)) continue;
    if (reading.intent === 'already_paid') return paymentCheck(v, note, reading, world);
    if (reading.intent === 'material_event') return materialEventCase(v, note, reading, world);
    if (reading.intent === 'exception_request') return exceptionCase(v, note, reading, world);
  }
  return undefined;
}

export function rmReplyMove(v: ClientView, note: RmNoteRow, finding: string, reading?: RmReading): NoticeMove {
  return {
    kind: 'notice', channel: 'rm', body: `${finding} ${noteTag(note.id)}`, policyRef: 'pol-007', confidence: 0.9,
    reasoning: bullets([`${note.author} says ${v.client.name} already paid.`, 'Checked the bank feed before replying.', readBy(reading)]),
    summary: `reply to ${note.author} on ${v.client.name}'s payment`,
  };
}

function paymentCheck(v: ClientView, note: RmNoteRow, reading: RmReading, world: World): Move {
  const today = world.today;
  const name = v.client.name;
  const defaulted = defaultedInvoices(v, today);
  const owing = owed(defaulted);
  const since = defaulted.length ? defaulted.map((i) => i.dueOn).reduce((a, b) => (a < b ? a : b)) : today;
  const recent = v.cash.filter((m) => m.valueOn >= since);
  const quoted = (reading.paymentReference ?? '').toUpperCase();
  const cited = recent.filter((m) => quoted && (m.bankRef.toUpperCase().includes(quoted) || m.memo.toUpperCase().includes(quoted)));
  const match = byId(v.workItems).find((w) => w.kind === 'PAYMENT_MATCH' && OPEN.has(w.state));
  const returned = recent.filter((m) => m.matchStatus === 'reversed');

  let finding: string;
  if (!defaulted.length) {
    finding = `Confirmed: nothing from ${name} is past due any more. Any restriction is being lifted.`;
  } else if (v.inTransit.length) {
    const m = v.inTransit[0]!;
    finding = `We see ${usd(m.amountCents)} ${m.rail} ${m.bankRef} from ${m.origName} sent ${m.valueOn}, not yet posted. No further restriction while it is in transit; access comes back once it posts.`;
  } else if (match) {
    finding = `${waitingMatch(v, match, world)} The match is waiting for an accountant to approve (WI-${match.id}); access comes back as soon as it is applied.`;
  } else if (returned.length) {
    const m = returned[0]!;
    const code = m.returnCode ? ` (${m.returnCode})` : '';
    finding = `${usd(m.amountCents)} ${m.bankRef} from ${m.origName} arrived ${m.valueOn} but was returned by the bank${code}; ${usd(owing)} is still past due. Please ask the client to resend.`;
  } else {
    const found = bestCandidate(v, reading, note, world, since);
    if (found) {
      const { m, evidence } = found;
      const reply = rmReplyMove(v, note, `${usd(m.amountCents)} ${m.bankRef} from ${m.origName} arrived ${m.valueOn} but could not be matched automatically; an accountant is reviewing it. Access comes back as soon as it is applied.`, reading);
      const after = rmReplyMove(v, note, `${foundPayment(m.amountCents, m.origName, evidence.invoices, m.bankRef, m.valueOn)} It is being applied now; access comes back as soon as it is.`, reading);
      return {
        kind: 'payment_match', movementId: m.id, rmNoteId: note.id, evidence, reply, after,
        reasoning: bullets([`${note.author} says ${name} paid.`, ...evidence.signals.filter((s) => s.kind !== 'rm_says_paid').map((s) => sentence(s.detail)), readBy(reading)]),
        summary: `match ${m.bankRef} to ${name} on ${note.author}'s word and the evidence`,
      };
    }
    const applied = recent.filter((m) => m.matchStatus === 'matched').reduce((s, m) => s + m.amountCents, 0);
    const claimed = reading.claimedAmountUsd ? ` ${usd(Math.round(reading.claimedAmountUsd * 100))} payment` : ' payment';
    const notFound = reading.paymentReference && !cited.length ? ` (reference ${reading.paymentReference} not found)` : '';
    finding = `No${claimed} from ${name} has reached our bank feed since ${since}${notFound}. ${applied ? `${usd(applied)} was received and applied; ` : ''}${usd(owing)} is still past due (${ids(defaulted)}). Restrictions stay as they are. Please ask the client for the Fed IMAD or MT103 so we can trace the wire.`;
  }
  return rmReplyMove(v, note, finding, reading);
}

const MATCH_TITLE = /^Confirm (\$[\d,]+\.\d{2}) from (.+?)(?: → (.+?))?(?: \([^()]*\))?$/;

/** We found it: the $148,200.00 payment from HALVARD GP HOLDINGS (JD-0042, received 2026-03-18) pays INV-1 and INV-2. */
export function foundPayment(amountCents: number | undefined, sender: string, invoices: string[], ref = '', on = ''): string {
  const detail = [ref, on ? `received ${on}` : ''].filter(Boolean).join(', ');
  return `We found it: the ${amountCents ? `${usd(amountCents)} ` : ''}payment${sender ? ` from ${sender}` : ''}${detail ? ` (${detail})` : ''}${invoices.length ? ` pays ${listed(invoices)}` : ''}.`;
}

/** What an open PAYMENT_MATCH found, from its plan, the cash movement and, failing those, its title. */
function waitingMatch(v: ClientView, match: WorkItemRow, world: World): string {
  const proposal = proposalOf(match);
  const allocations: { invoiceId?: string }[] = proposal.plan?.allocations ?? [];
  let invoices = allocations.map((a) => a.invoiceId).filter((i): i is string => !!i);
  const movementId = proposal.movementId ?? match.subjectId;
  const m = [...v.cash, ...world.unplaced()].find((c) => c.id === movementId);
  const titled = MATCH_TITLE.exec(match.title);
  let amount: number | undefined = match.amountCents || m?.amountCents;
  const sender = m ? m.origName : titled?.[2] ?? '';
  if (!invoices.length && titled?.[3]) invoices = titled[3].split(',').map((i) => i.trim());
  if (!amount && titled) amount = Number(titled[1]!.replace(/[$,.]/g, ''));
  return foundPayment(amount, sender, invoices, m?.bankRef ?? '', m?.valueOn ?? '');
}

/** The unapplied or unplaced wire most likely this client's, if the evidence is strong enough. */
function bestCandidate(v: ClientView, reading: RmReading, note: RmNoteRow, world: World, since: string) {
  const open = openInvoices(v);
  const floor = open.length ? open.map((i) => i.issuedOn).reduce((a, b) => (a < b ? a : b)) : since;
  const pool = [...v.cash.filter((m) => m.status === 'posted' && UNAPPLIED.has(m.matchStatus)), ...world.unplaced()];
  const scored: { m: CashRow; evidence: WireEvidence }[] = [];
  for (const m of pool) {
    if (m.valueOn < floor) continue;
    const evidence = wireEvidence(v, m, reading, note, open);
    if (evidence) scored.push({ m, evidence });
  }
  scored.sort((a, b) => b.evidence.confidence - a.evidence.confidence || (a.m.id < b.m.id ? 1 : -1));
  if (!scored.length || (scored.length > 1 && scored[0]!.evidence.confidence === scored[1]!.evidence.confidence)) return undefined;
  return scored[0];
}

/** Signals that this wire is the client's. A match needs the amount to fit and at least one more signal. */
export function wireEvidence(v: ClientView, m: CashRow, reading: RmReading, note: RmNoteRow, open: ClientView['invoices']): WireEvidence | undefined {
  const amount = m.amountCents;
  const signals = [{ kind: 'rm_says_paid', detail: `RM ${note.author} wrote: “${note.text.slice(0, 160)}”` }];
  const subset = exactSubset(amount, open);
  const claimed = reading.claimedAmountUsd ? Math.round(reading.claimedAmountUsd * 100) : undefined;
  const closeToClaim = claimed !== undefined && Math.abs(claimed - amount) <= FEE_TOLERANCE_CENTS;
  if (subset) signals.push({ kind: 'amount_matches_invoices', detail: `${usd(amount)} equals open invoices ${ids(subset)}` });
  else if (closeToClaim) signals.push({ kind: 'amount_matches_claim', detail: `${usd(amount)} is what the RM says was sent (${usd(claimed!)})` });
  else return undefined;
  const text = [m.memo, m.remittance, m.origName].join(' ').toUpperCase();
  const quoted = (reading.paymentReference ?? '').toUpperCase();
  if (quoted && (m.bankRef.toUpperCase().includes(quoted) || text.includes(quoted))) signals.push({ kind: 'reference', detail: `the RM's reference ${reading.paymentReference} is on the wire` });
  const named = [...new Set([v.client.id, v.client.name.toUpperCase(), v.client.legalName.toUpperCase()])].filter((n) => n && text.includes(n));
  const refs = open.map((i) => i.id).filter((id) => m.refs.includes(id));
  if (named.length || refs.length) signals.push({ kind: 'remittance_names_client', detail: `the wire mentions ${[...named.sort(), ...refs.sort()].join(', ')}` });
  if (v.cash.includes(m)) signals.push({ kind: 'known_sender', detail: `${m.origName} is already on file for ${v.client.name}` });
  if (closeToClaim && subset) signals.push({ kind: 'amount_matches_claim', detail: `the RM quoted ${usd(claimed!)}` });
  if (signals.length < 3 && !subset) return undefined;
  return {
    kind: 'payment_attribution', movementId: m.id, bankRef: m.bankRef, amountCents: amount, from: m.origName, valueOn: m.valueOn,
    invoices: (subset ?? []).map((i) => i.id), signals, confidence: Math.round(Math.min(0.95, 0.45 + 0.15 * (signals.length - 1)) * 100) / 100,
  };
}

/** Oldest-first set of open invoices whose balances add up to the amount exactly (small books only). */
export function exactSubset(amount: number, invoices: ClientView['invoices']): ClientView['invoices'] | undefined {
  const items = [...invoices].sort((a, b) => (a.dueOn === b.dueOn ? (a.id < b.id ? -1 : 1) : a.dueOn < b.dueOn ? -1 : 1)).slice(0, 16);
  const balances = items.map((i) => i.amountCents - i.paidCents);
  const pick = (start: number, size: number, left: number, chosen: number[]): number[] | undefined => {
    if (size === 0) return left === 0 ? chosen : undefined;
    for (let k = start; k <= items.length - size; k++) {
      const found = pick(k + 1, size - 1, left - balances[k]!, [...chosen, k]);
      if (found) return found;
    }
    return undefined;
  };
  for (let size = 1; size <= items.length; size++) {
    const found = pick(0, size, amount, []);
    if (found) return found.map((k) => items[k]!);
  }
  return undefined;
}

function exceptionCase(v: ClientView, note: RmNoteRow, reading: RmReading, world: World): Move {
  const defaulted = defaultedInvoices(v, world.today);
  const restricted = v.levers.filter((l) => l.state === 'limited' || l.state === 'off').map((l) => `${l.lever} (${l.detail})`);
  const past = v.precedents.filter((p) => p.decision);
  const facts = bullets([
    defaulted.length ? `${usdShort(owed(defaulted))} past due on ${plural(defaulted.length, 'invoice')}.` : 'Nothing is in default today.',
    restricted.length ? `Restricted now: ${restricted.join(', ')}.` : 'No restrictions in place.',
    past.length > 0 && `Past decisions on this client: ${past.slice(-3).map((p) => `${p.decision.toLowerCase()} on ${day(p.decidedOn)}${p.outcome ? ` (${p.outcome.toLowerCase()})` : ''}`).join(', ')}.`,
    `The agent cannot grant exceptions, so a controller decides. Escalation is paused while this is open.${readBy(reading) ? ` ${readBy(reading)}` : ''}`,
  ]);
  const proposal: CaseProposal = {
    kind: 'NOVEL_CASE', subjectId: `rm_note:${note.id}`, title: `${note.author} asks to hold off on ${v.client.name}`, amountCents: owed(defaulted),
    proposal: { rmNoteId: note.id, request: note.text, graceUntil: reading.graceUntil, reason: reading.reason, summary: reading.summary },
    reasoning: facts, policyRef: 'pol-006', clausesCited: [], confidence: 0.5,
  };
  return { kind: 'case', proposal, summary: proposal.title };
}

const EVENT_WORDS: Record<string, string> = {
  acquisition: 'being acquired', merger: 'merging', insolvency: 'insolvent', wind_down: 'winding down',
  regulatory: 'under regulatory action', other: 'going through a material change',
};

function materialEventCase(v: ClientView, note: RmNoteRow, reading: RmReading, world: World): Move {
  const name = v.client.name;
  const event = reading.eventType ?? 'other';
  const who = !reading.counterparty ? '' : event === 'acquisition' ? ` by ${reading.counterparty}` : event === 'merger' ? ` with ${reading.counterparty}` : '';
  const when = reading.effectiveDate;
  const defaulted = defaultedInvoices(v, world.today);
  const open = openInvoices(v);
  const inDefault = owed(defaulted);
  const totalOpen = owed(open);
  const cash = usdCash(v);
  const custody = v.custody.reduce((s, h) => s + h.valueCents, 0);
  const coc = clause(v, 'change_of_control');
  const setOff = clause(v, 'set_off');
  const debit = clause(v, 'debit');
  const cure = latestDeadline(v, 'cure_period');
  const withdrawn = v.accessRequests.filter((r) => r.action === 'withdraw' && r.decision !== 'denied').reduce((s, r) => s + r.allowedCents, 0);
  const flagged = v.flags.filter((f) => f.status === 'open');
  const covering = world.policies.filter((p) => /change of control|acqui|merger|insolv/i.test(p.title + p.ruleJson)).map((p) => p.title);

  const steps: [string, string][] = [
    ['rm_note', `${note.author}: ${name} is ${EVENT_WORDS[event]}${who}${when ? `, effective ${day(when)}` : ''}.`],
    ['policy_search', covering.length ? `Covered by ${listed(covering)}.` : `None of the ${world.policies.length} active policies covers a change of control, so this needs a controller.`],
    ['contract', [
      coc?.allowed ? `Change of control: ${sentence(coc.text)}` : 'No change-of-control clause.',
      setOff?.allowed ? 'Set-off is allowed.' : 'No set-off right.',
      debit?.allowed ? 'Custody debits are allowed.' : 'Debits need the client\'s written consent.',
      cure?.status === 'open' ? `The cure period runs until ${day(cure.dueOn)}.` : cure?.status === 'expired' ? `The cure period ran out on ${day(cure.dueOn)}.` : '',
    ].filter(Boolean).join(' ')],
    ['exposure', `${usdShort(inDefault)} in default and ${usdShort(totalOpen)} open in total. Custody holds ${usdShort(cash)} in USD of ${usdShort(custody)} overall.`],
    ['custody_activity', `${withdrawn ? `${usdShort(withdrawn)} withdrawn from custody through the platform.` : 'No withdrawals through the platform.'}${flagged.length ? ` Open flags: ${flagged.map((f) => f.pattern.replace(/_/g, ' ')).join(', ')}.` : ''}`],
  ];
  const past = v.precedents.filter((p) => p.decision);
  if (past.length) steps.push(['precedents', past.slice(-3).map((p) => sentence(`${day(p.decidedOn)}: ${p.proposed}, ${p.decision.toLowerCase()}${p.outcome ? `, ${p.outcome.toLowerCase()}` : ''}`)).join(' ')]);

  const plan: string[] = [];
  if (coc?.allowed) plan.push(`Invoke the change-of-control clause. All ${usdShort(totalOpen)} open becomes payable at closing${when ? ` on ${day(when)}` : ''}. Send the acquirer a payoff statement.`);
  if (cure?.status === 'open') plan.push(`No restriction before the cure period ends ${day(cure.dueOn)}.`);
  const running = v.levers.filter((l) => l.lever !== 'withdrawals' && l.state !== 'not_used').map((l) => (l.lever === 'api' ? 'API access' : l.lever));
  if (setOff?.allowed && inDefault) plan.push(`If still unpaid then, hold ${usdShort(inDefault)} of withdrawals under the set-off right. Keep ${running.join(' and ') || 'everything else'} running so the deal is not disrupted.`);
  if (!debit?.allowed) plan.push('Ask the RM for written consent to debit custody, which would settle it today.');
  if (cash < totalOpen || flagged.length) plan.push('Custody cash is moving out. Secure the balance before closing rather than after.');
  plan.push(`Ask ${note.author} for the closing date, the acquirer's legal entity and whether the MSA is assigned.`);
  steps.push(['proposal', plan.join(' ')]);

  const proposal: CaseProposal = {
    kind: 'NOVEL_CASE', subjectId: `rm_note:${note.id}`, title: `${name} is ${EVENT_WORDS[event]}${who}: no policy covers it`, amountCents: totalOpen,
    proposal: { rmNoteId: note.id, event, counterparty: reading.counterparty, effectiveDate: when, onlyLevers: ['withdrawals'], investigation: steps.map(([tool, summary]) => ({ tool, summary })) },
    reasoning: bullets([...plan, readBy(reading)]), policyRef: 'none',
    clausesCited: [coc, setOff].filter((c) => c?.allowed).map((c) => c!.clause), confidence: 0.6,
  };
  return { kind: 'case', proposal, summary: proposal.title };
}

/** Restrictions the controller agreed to for this default (an approved NOVEL_CASE's onlyLevers), or undefined when nothing was agreed. */
export function agreedLevers(v: ClientView, since: string): Set<string> | undefined {
  const approved = new Set(v.approvals.filter((a) => a.simDate >= since).map((a) => a.workItemId));
  const inUse = new Set(v.levers.filter((l) => l.state !== 'not_used').map((l) => l.lever));
  for (const w of v.workItems) {
    if (w.kind !== 'NOVEL_CASE' || !approved.has(w.id)) continue;
    const levers = new Set<string>(proposalOf(w).onlyLevers ?? []);
    if (levers.has('withdrawals') && !allowed(v, 'set_off')) levers.delete('withdrawals');
    for (const l of levers) if (!inUse.has(l)) levers.delete(l);
    if (levers.size) return levers;
  }
  return undefined;
}
