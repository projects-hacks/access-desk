import { SenderError, t } from 'spacetimedb/server';
import { actorOf, addDays, audit, requireRole, simDate, type Ctx } from '../context';
import { createWorkItem, overdueCents, recomputeInvoice, releaseHoldsIfCured, withdrawStaleProposals } from '../payments/apply';
import { GL, cr, dr, queueCommand, queueJournal } from '../payments/gateway';
import { cureState, defaultedInvoices } from '../payments/deadlines';
import { formatUsd } from '../payments/match';
import { spacetimedb } from '../schema';
import { applyCreditReview, applyPolicyDraft } from './credit';

/**
 * Actions agents (and people) can propose. Each one is checked against the
 * contract, the platform's capabilities and policy before a work item exists.
 * Approval (or policy auto-approval) executes it through the gateway.
 *
 * Auto-approval follows the platform settings: an active policy covers it, the
 * amount is within the auto-apply limit, the client is not Tier 1 or strategic,
 * and it is not a restriction (restrictions always need a controller).
 */

const PROPOSERS = ['AGENT', 'CONTROLLER', 'ADMIN'] as const;
/** Kinds that may run without a person, and the policy that must be active for it. */
const AUTO_POLICY: Record<string, string> = { CUSTODY_DEBIT: 'pol-005', RESTORE: 'pol-011', REMINDER: 'pol-007' };
const LEVERS = ['withdrawals', 'trading', 'api', 'financing'] as const;
/** Lever state and label after each restriction step. */
const STEP_EFFECT: Record<string, { state: string; detail: string }> = {
  REQUIRE_PREPAY: { state: 'limited', detail: 'Prepay required' },
  RATE_LIMIT: { state: 'limited', detail: 'Rate limited to 100 req/s' },
  READ_ONLY: { state: 'limited', detail: 'Read-only' },
  PAUSE_OTC: { state: 'limited', detail: 'OTC paused' },
  NO_NEW_POSITIONS: { state: 'limited', detail: 'No new positions · closing allowed' },
  CLOSE_ONLY: { state: 'limited', detail: 'Close-only' },
  NO_NEW_BORROWING: { state: 'off', detail: 'No new borrowing' },
  LOWER_LINE: { state: 'limited', detail: 'Credit line lowered' },
};

// ── Shared checks ───────────────────────────────────────────────────────────

function client(ctx: Ctx, clientId: string) {
  const c = ctx.db.client.id.find(clientId);
  if (!c) throw new SenderError(`unknown client ${clientId}`);
  return c;
}

function clause(ctx: Ctx, clientId: string, kind: string) {
  return [...ctx.db.contractClause.clientId.filter(clientId)].find((c) => c.kind === kind);
}

/** Overdue, undisputed invoices on the sim date: what may be collected or secured. */
function overdueInvoices(ctx: Ctx, clientId: string) {
  const today = simDate(ctx);
  return [...ctx.db.invoice.clientId.filter(clientId)].filter(
    (i) => i.dueOn < today && i.status !== 'disputed' && i.paidCents < i.amountCents,
  );
}

function usdCash(ctx: Ctx, clientId: string): bigint {
  return ctx.db.custodyHolding.id.find(`${clientId}:USD`)?.valueCents ?? 0n;
}

function heldCents(ctx: Ctx, clientId: string): bigint {
  return [...ctx.db.hold.clientId.filter(clientId)].filter((h) => h.status === 'active').reduce((s, h) => s + h.amountCents, 0n);
}

function policyActive(ctx: Ctx, policyId: string): boolean {
  return [...ctx.db.policy.policyId.filter(policyId)].some((p) => p.status === 'active');
}

export function canAutoApply(ctx: Ctx, kind: string, clientId: string, amountCents: bigint): boolean {
  const policy = AUTO_POLICY[kind];
  const c = ctx.db.client.id.find(clientId);
  const limit = ctx.db.platform.id.find(1)?.autoApplyLimitCents ?? 0n;
  return !!policy && policyActive(ctx, policy) && amountCents <= limit && !!c && c.tier > 1 && !c.strategic;
}

/** Create the work item; execute right away when policy allows. */
function propose(ctx: Ctx, w: {
  kind: string; clientId: string; title: string; amountCents: bigint; proposal: Record<string, unknown>;
  reasoning: string; policyRef: string; clausesCited: string[]; confidence: number;
}) {
  requireRole(ctx, PROPOSERS);
  const auto = canAutoApply(ctx, w.kind, w.clientId, w.amountCents);
  const item = createWorkItem(ctx, {
    kind: w.kind, clientId: w.clientId, subjectId: w.clientId, title: w.title, amountCents: w.amountCents,
    proposal: w.proposal, reasoning: w.reasoning, policyRef: w.policyRef, confidence: w.confidence,
    requiredRole: 'CONTROLLER', autoApplied: auto,
  });
  if (w.clausesCited.length) ctx.db.workItem.id.update({ ...item, clausesCited: w.clausesCited });
  if (auto) executeApproved(ctx, item.id);
  return item;
}

// ── Holds (shared with the admin stand-in) ──────────────────────────────────

export function placeHoldFor(ctx: Ctx, clientId: string, amountCents: bigint, invoiceIds: string[], clauseRef: string, reason: string, workItemId?: bigint) {
  const hold = ctx.db.hold.insert({
    id: 0n, clientId, amountCents, reason, clause: clauseRef, invoiceIds, workItemId, status: 'active',
    createdAt: ctx.timestamp, releasedAt: undefined,
  });
  queueCommand(ctx, `PLACE_HOLD:${hold.id}`, { type: 'PLACE_HOLD', clientId, holdId: String(hold.id), amountCents, clause: clauseRef }, workItemId);
  const lever = ctx.db.accessLever.id.find(`${clientId}:withdrawals`);
  if (lever) ctx.db.accessLever.id.update({ ...lever, state: 'limited', detail: `${formatUsd(amountCents)} held (§${clauseRef})`, workItemId });
  const c = ctx.db.client.id.find(clientId);
  if (c) ctx.db.client.id.update({ ...c, status: 'held' });
  audit(ctx, { action: 'HOLD_PLACED', subjectType: 'hold', subjectId: String(hold.id), clientId, workItemId, toState: 'active', detail: `${formatUsd(amountCents)} · ${reason} · secures ${invoiceIds.join(', ')}` });
  return hold;
}

// ── Proposals ───────────────────────────────────────────────────────────────

/** Collect overdue fees from the client's custody cash (needs a signed debit clause). */
export const proposeCustodyDebit = spacetimedb.reducer(
  { clientId: t.string(), invoiceIds: t.array(t.string()), reasoning: t.string(), policyRef: t.string(), confidence: t.f32() },
  (ctx, { clientId, invoiceIds, reasoning, policyRef, confidence }) => {
    client(ctx, clientId);
    const debit = clause(ctx, clientId, 'debit');
    if (!debit?.allowed) throw new SenderError(`§${debit?.clause ?? '6.3'}: debits from custody need the client's consent for each debit`);
    const overdue = new Map(overdueInvoices(ctx, clientId).map((i) => [i.id, i]));
    const chosen = invoiceIds.length ? invoiceIds : [...overdue.keys()];
    const missing = chosen.filter((id) => !overdue.has(id));
    if (!chosen.length) throw new SenderError('nothing overdue to collect');
    if (missing.length) throw new SenderError(`not overdue, disputed or not this client's: ${missing.join(', ')}`);
    const amount = chosen.reduce((s, id) => s + overdue.get(id)!.amountCents - overdue.get(id)!.paidCents, 0n);
    if (usdCash(ctx, clientId) < amount) throw new SenderError(`custody USD ${formatUsd(usdCash(ctx, clientId))} is less than ${formatUsd(amount)} owed`);
    propose(ctx, {
      kind: 'CUSTODY_DEBIT', clientId, amountCents: amount, policyRef, clausesCited: [debit.clause],
      title: `Debit ${formatUsd(amount)} from custody for ${chosen.join(', ')}`,
      proposal: { invoiceIds: chosen, amountCents: amount }, reasoning, confidence,
    });
  },
);

/** Restrict one lever by one step of the platform's ladder. Never more than owed; never halts a hedged book. */
export const proposeRestriction = spacetimedb.reducer(
  { clientId: t.string(), lever: t.string(), step: t.string(), reasoning: t.string(), policyRef: t.string(), confidence: t.f32() },
  (ctx, { clientId, lever, step, reasoning, policyRef, confidence }) => {
    const c = client(ctx, clientId);
    if (!(LEVERS as readonly string[]).includes(lever)) throw new SenderError(`unknown lever ${lever}`);
    const current = ctx.db.accessLever.id.find(`${clientId}:${lever}`);
    if (!current || current.state === 'not_used') throw new SenderError(`${lever} is not part of ${c.name}'s contract`);
    const capabilityOk = [...ctx.db.capability.iter()].some((k) => k.lever === lever && k.step === step);
    if (!capabilityOk) throw new SenderError(`the platform cannot ${step} on ${lever}`);
    if (step === 'FULL_FREEZE') throw new SenderError('a full freeze needs two approvers; propose a hold of the amount owed instead');

    const overdue = overdueInvoices(ctx, clientId);
    if (!overdue.length) throw new SenderError(`${c.name} has nothing overdue`);
    const owed = overdue.reduce((s, i) => s + i.amountCents - i.paidCents, 0n);
    const contract = ctx.db.contract.clientId.find(clientId);
    const products = new Set(overdue.map((i) => i.product));
    const leverProduct: Record<string, string> = { withdrawals: 'CUSTODY', trading: 'TRADING', api: 'API', financing: 'FINANCING' };
    const setOff = clause(ctx, clientId, 'set_off');
    const cited: string[] = [];
    if (lever === 'withdrawals') {
      if (!setOff?.allowed) throw new SenderError('no set-off right: withdrawals cannot be held');
      cited.push(setOff.clause);
    } else if (!products.has(leverProduct[lever]!) && !contract?.crossDefault) {
      throw new SenderError(`nothing overdue on ${lever}, and the contract has no cross-default`);
    }
    const hedged = [...ctx.db.position.clientId.filter(clientId)].some((p) => p.status === 'open' && p.hedgeGroup);
    if (lever === 'trading' && hedged && step === 'CLOSE_ONLY') throw new SenderError('pol-008: never force a hedged book to close-only; propose NO_NEW_POSITIONS');
    // §9.1: no restriction until a default notice has gone out and the cure period has run.
    const cure = clause(ctx, clientId, 'cure');
    if (cure?.allowed) {
      const s = cureState(ctx, clientId);
      const days = contract?.cureDays ?? 0;
      if (s.state === 'none') throw new SenderError(`§${cure.clause}: no default notice yet; send one (propose_notice), then the ${days}-day cure period runs`);
      if (s.state === 'running') throw new SenderError(`§${cure.clause}: cure period runs until ${s.dueOn} (notice of ${s.startedOn})`);
      cited.push(cure.clause);
    }

    const isHold = lever === 'withdrawals' && step === 'HOLD_AMOUNT_OWED';
    propose(ctx, {
      kind: 'RESTRICTION', clientId, amountCents: isHold ? owed : 0n, policyRef, clausesCited: cited,
      title: isHold ? `Hold ${formatUsd(owed)} of ${c.name}'s withdrawals` : `${step.replace(/_/g, ' ').toLowerCase()} on ${c.name}'s ${lever}`,
      proposal: { lever, step, amountCents: isHold ? owed : 0n, invoiceIds: overdue.map((i) => i.id), clause: cited[0] ?? '' },
      reasoning, confidence,
    });
  },
);

/** Give access back on one lever (releases holds on withdrawals). */
export const proposeRestore = spacetimedb.reducer(
  { clientId: t.string(), lever: t.string(), reasoning: t.string(), policyRef: t.string(), confidence: t.f32() },
  (ctx, { clientId, lever, reasoning, policyRef, confidence }) => {
    const c = client(ctx, clientId);
    const current = ctx.db.accessLever.id.find(`${clientId}:${lever}`);
    if (!current || current.state === 'active' || current.state === 'not_used') throw new SenderError(`${lever} is not restricted for ${c.name}`);
    propose(ctx, {
      kind: 'RESTORE', clientId, amountCents: 0n, policyRef, clausesCited: [],
      title: `Restore ${c.name}'s ${lever}`, proposal: { lever }, reasoning, confidence,
    });
  },
);

/** A notice or reminder to the client, sent through the gateway. */
export const proposeNotice = spacetimedb.reducer(
  { clientId: t.string(), channel: t.string(), body: t.string(), reasoning: t.string(), policyRef: t.string(), confidence: t.f32() },
  (ctx, { clientId, channel, body, reasoning, policyRef, confidence }) => {
    const c = client(ctx, clientId);
    if (!['email', 'portal', 'rm'].includes(channel)) throw new SenderError(`unknown channel ${channel}`);
    if (!body.trim()) throw new SenderError('empty notice');
    propose(ctx, {
      kind: 'REMINDER', clientId, amountCents: 0n, policyRef, clausesCited: [],
      title: `${channel === 'rm' ? 'RM note' : 'Notice'} to ${c.name} (${channel})`, proposal: { channel, body }, reasoning, confidence,
    });
  },
);

/**
 * A client asks to withdraw USD from custody. Anything not held is released at
 * once; the held part stays. ("$26,000 approved, $24,000 held.")
 */
export const requestCustodyWithdrawal = spacetimedb.reducer(
  { clientId: t.string(), amountCents: t.i64() },
  (ctx, { clientId, amountCents }) => {
    const role = requireRole(ctx, ['CLIENT', 'DEMO', 'CONTROLLER', 'ADMIN']);
    if (role === 'CLIENT' && actorOf(ctx)?.clientId !== clientId) throw new SenderError('clients can only withdraw from their own account');
    const c = client(ctx, clientId);
    if (amountCents <= 0n) throw new SenderError('amount must be positive');
    const pending = [...ctx.db.gatewayCommand.type.filter('CUSTODY_WITHDRAWAL')]
      .filter((cmd) => (cmd.status === 'queued' || cmd.status === 'executing') && JSON.parse(cmd.actionJson).clientId === clientId)
      .reduce((s, cmd) => s + BigInt(JSON.parse(cmd.actionJson).amountCents), 0n);
    const held = heldCents(ctx, clientId);
    const available = usdCash(ctx, clientId) - held - pending;
    const allowed = available <= 0n ? 0n : amountCents < available ? amountCents : available;
    const withheld = amountCents - allowed;
    const setOff = clause(ctx, clientId, 'set_off');
    const reason = withheld > 0n
      ? `${formatUsd(held)} held under §${setOff?.clause ?? '7.2'} against overdue invoices; ${formatUsd(allowed)} available`
      : 'Within available balance';
    const request = ctx.db.accessRequest.insert({
      id: 0n, clientId, action: 'withdraw', amountCents, decision: allowed === amountCents ? 'approved' : allowed > 0n ? 'partial' : 'denied',
      allowedCents: allowed, heldCents: withheld, reason, at: ctx.timestamp,
    });
    if (allowed > 0n) {
      queueCommand(ctx, `CUSTODY_WITHDRAWAL:${request.id}`, {
        type: 'CUSTODY_WITHDRAWAL', clientId, withdrawalId: String(request.id), amountCents: allowed, on: simDate(ctx),
      });
    }
    flagCureWithdrawal(ctx, c.name, clientId, request.id, allowed, usdCash(ctx, clientId) - pending);
    audit(ctx, {
      action: 'WITHDRAWAL_REQUESTED', subjectType: 'access_request', subjectId: String(request.id), clientId,
      toState: request.decision, detail: `${c.name} asked ${formatUsd(amountCents)}: ${formatUsd(allowed)} approved, ${formatUsd(withheld)} held`,
    });
  },
);

/**
 * Money leaving custody while the client is in default and its cure period
 * runs. The contract forbids restricting before the cure period ends, so the
 * withdrawal goes through; the controller and agents get an exploit flag when
 * what's left would no longer cover the amount in default.
 */
function flagCureWithdrawal(ctx: Ctx, name: string, clientId: string, requestId: bigint, releasedCents: bigint, usdBeforeCents: bigint) {
  const cure = cureState(ctx, clientId);
  if (cure.state !== 'running' || releasedCents <= 0n) return;
  const inDefaultCents = defaultedInvoices(ctx, clientId).reduce((s, i) => s + i.amountCents - i.paidCents, 0n);
  const leftCents = usdBeforeCents - releasedCents;
  if (leftCents >= inDefaultCents) return;
  const evidence = {
    requestId: String(requestId), releasedCents: String(releasedCents), usdBeforeCents: String(usdBeforeCents), usdAfterCents: String(leftCents),
    inDefaultCents: String(inDefaultCents), cureStartedOn: cure.startedOn, cureEndsOn: cure.dueOn,
  };
  ctx.db.exploitFlag.insert({
    id: `cure-withdrawal:${requestId}`, clientId, pattern: 'withdrawal_during_cure', score: 0.9, status: 'open', months: 0,
    evidenceJson: JSON.stringify(evidence),
    proposedFix: `Call the client today; when the cure period ends on ${cure.dueOn}, hold the amount in default under the set-off clause.`,
  });
  createWorkItem(ctx, {
    kind: 'EXPLOIT_FLAG', clientId, subjectId: `access_request:${requestId}`, amountCents: releasedCents,
    title: `${name} withdrew ${formatUsd(releasedCents)} during its cure period`,
    proposal: evidence, policyRef: 'pol-006', confidence: 0.9, requiredRole: 'CONTROLLER', autoApplied: false,
    reasoning: `In default on ${formatUsd(inDefaultCents)} with the cure period running until ${cure.dueOn}. The withdrawal had to be honored (§9.1), `
      + `and custody cash is now ${formatUsd(leftCents)}, below what is in default.`,
  });
}

// ── Execution on approval ───────────────────────────────────────────────────

/** Runs an approved action. Called by transition_work_item (APPROVED) and by auto-approval. */
export function executeApproved(ctx: Ctx, workItemId: bigint) {
  const item = ctx.db.workItem.id.find(workItemId);
  if (!item) return;
  const p = JSON.parse(item.proposalJson);
  const today = simDate(ctx);
  switch (item.kind) {
    case 'CUSTODY_DEBIT': {
      const invoices = (p.invoiceIds as string[]).map((id) => ctx.db.invoice.id.find(id)).filter((i) => !!i);
      const apps = invoices.map((inv) => ctx.db.paymentApplication.insert({
        id: 0n, movementId: `custody:${item.id}`, invoiceId: inv.id, amountCents: inv.amountCents - inv.paidCents,
        method: 'custody_debit', policyRef: item.policyRef, workItemId: item.id, reversed: false, posted: false, reversalPosted: false,
      }));
      const amount = apps.reduce((s, a) => s + a.amountCents, 0n);
      for (const inv of invoices) recomputeInvoice(ctx, inv.id, today);
      queueCommand(ctx, `CUSTODY_DEBIT:${item.id}`, {
        type: 'CUSTODY_DEBIT', clientId: item.clientId, amountCents: amount, on: today, invoiceIds: invoices.map((i) => i.id),
        applications: apps.map((a) => ({ applicationId: String(a.id), invoiceId: a.invoiceId, amountCents: a.amountCents })),
      }, item.id);
      queueJournal(ctx, `JE-CD-${item.id}`, today, `CD-${item.id}`, `Fees collected from custody · ${invoices.map((i) => i.id).join(' ')}`,
        [dr(GL.CLIENT_FUNDS, amount), cr(GL.RECEIVABLES, amount)], item.id);
      withdrawStaleProposals(ctx, item.clientId, `fees collected from custody (${item.id})`);
      releaseHoldsIfCured(ctx, item.clientId, 'fees collected from custody', item.id);
      return;
    }
    case 'RESTRICTION': {
      if (p.lever === 'withdrawals' && p.step === 'HOLD_AMOUNT_OWED') {
        // Re-check at approval time: never hold more than is still owed.
        const owed = overdueCents(ctx, item.clientId);
        const amount = BigInt(p.amountCents) < owed ? BigInt(p.amountCents) : owed;
        if (amount <= 0n) throw new SenderError('nothing is owed any more');
        placeHoldFor(ctx, item.clientId, amount, p.invoiceIds, p.clause || '7.2', item.title, item.id);
        return;
      }
      const effect = STEP_EFFECT[p.step] ?? { state: 'limited', detail: p.step };
      queueCommand(ctx, `SET_LEVER:${item.id}`, { type: 'SET_LEVER', clientId: item.clientId, lever: p.lever, state: effect.state, detail: effect.detail }, item.id);
      const lever = ctx.db.accessLever.id.find(`${item.clientId}:${p.lever}`);
      if (lever) ctx.db.accessLever.id.update({ ...lever, state: effect.state, detail: effect.detail, workItemId: item.id });
      const c = ctx.db.client.id.find(item.clientId);
      if (c && c.status !== 'held') ctx.db.client.id.update({ ...c, status: 'restricted' });
      return;
    }
    case 'RESTORE': {
      if (p.lever === 'withdrawals') {
        for (const h of [...ctx.db.hold.clientId.filter(item.clientId)].filter((x) => x.status === 'active')) {
          ctx.db.hold.id.update({ ...h, status: 'released', releasedAt: ctx.timestamp });
          queueCommand(ctx, `RELEASE_HOLD:${h.id}`, { type: 'RELEASE_HOLD', clientId: item.clientId, holdId: String(h.id) }, item.id);
        }
      } else {
        queueCommand(ctx, `SET_LEVER:${item.id}`, { type: 'SET_LEVER', clientId: item.clientId, lever: p.lever, state: 'active', detail: 'Restored' }, item.id);
      }
      const lever = ctx.db.accessLever.id.find(`${item.clientId}:${p.lever}`);
      if (lever) ctx.db.accessLever.id.update({ ...lever, state: 'active', detail: 'Restored', workItemId: item.id });
      const stillLimited = [...ctx.db.accessLever.clientId.filter(item.clientId)].some((l) => l.state === 'limited' || l.state === 'off');
      const c = ctx.db.client.id.find(item.clientId);
      if (c && !stillLimited) ctx.db.client.id.update({ ...c, status: 'active' });
      return;
    }
    case 'REMINDER': {
      const notice = ctx.db.notice.insert({
        id: 0n, clientId: item.clientId, workItemId: item.id, channel: p.channel, body: p.body, status: 'queued', sentOn: simDate(ctx), ref: `WI-${item.id}`, sentAt: undefined,
      });
      queueCommand(ctx, `SEND_NOTICE:${notice.id}`, { type: 'SEND_NOTICE', clientId: item.clientId, channel: p.channel, body: p.body, noticeId: String(notice.id) }, item.id);
      return;
    }
    case 'CREDIT_REVIEW': {
      applyCreditReview(ctx, item.id);
      return;
    }
    case 'POLICY_DRAFT': {
      applyPolicyDraft(ctx, item.id);
      return;
    }
  }
}

// ── Time ────────────────────────────────────────────────────────────────────

/** A promise to pay or a follow-up date (e.g. from an RM call). Resolved automatically when the date comes. */
export const setDeadline = spacetimedb.reducer(
  { clientId: t.string(), kind: t.string(), dueOn: t.string(), note: t.string(), workItemId: t.u64().optional() },
  (ctx, { clientId, kind, dueOn, note, workItemId }) => {
    requireRole(ctx, ['AGENT', 'CONTROLLER', 'RELATIONSHIP_MANAGER', 'ADMIN']);
    client(ctx, clientId);
    if (kind !== 'promise_to_pay' && kind !== 'follow_up') throw new SenderError('kind must be promise_to_pay or follow_up (cure periods start from notices)');
    const today = simDate(ctx);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn) || dueOn <= today) throw new SenderError(`dueOn must be a date after ${today}`);
    const d = ctx.db.deadline.insert({ id: 0n, kind, clientId, workItemId, startedOn: today, dueOn, status: 'open', clause: '', note });
    audit(ctx, { action: 'DEADLINE_SET', subjectType: 'deadline', subjectId: String(d.id), clientId, workItemId, toState: 'open', detail: `${kind.replace(/_/g, ' ')} by ${dueOn}: ${note}` });
  },
);

/**
 * Dunning (pol-007), run as each sim day starts: a client newly past its grace
 * period gets a default notice, which starts the cure period once sent.
 */
export function sendDefaultNotices(ctx: Ctx) {
  if (!policyActive(ctx, 'pol-007')) return;
  const today = simDate(ctx);
  for (const c of [...ctx.db.client.iter()]) {
    const defaulted = defaultedInvoices(ctx, c.id, today);
    if (!defaulted.length || cureState(ctx, c.id).state !== 'none') continue;
    if ([...ctx.db.notice.clientId.filter(c.id)].some((n) => n.status === 'queued')) continue;
    const contract = ctx.db.contract.clientId.find(c.id);
    const owed = defaulted.reduce((s, i) => s + i.amountCents - i.paidCents, 0n);
    const list = defaulted.map((i) => `${i.id} (due ${i.dueOn})`).join(', ');
    const body = `Payment of ${formatUsd(owed)} is past due: ${list}. Under §9.1 you have ${contract?.cureDays ?? 0} days from this notice `
      + `(until ${addDays(today, contract?.cureDays ?? 0)}) to pay before access may be restricted.`;
    const item = createWorkItem(ctx, {
      kind: 'REMINDER', clientId: c.id, subjectId: c.id, title: `Default notice to ${c.name}`, amountCents: owed,
      proposal: { channel: 'email', body }, reasoning: `Past the ${contract?.graceDays ?? 0}-day grace period on ${list}.`,
      policyRef: 'pol-007', confidence: 1, requiredRole: 'CONTROLLER', autoApplied: true,
    });
    executeApproved(ctx, item.id);
  }
}
