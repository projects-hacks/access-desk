import { actorOf, type Ctx } from './context';
import { formatUsd } from './payments/match';
import { LEVER_LABEL } from './reducers/actions';

/**
 * The agents are woken by the database. A reducer that changes something an agent cares
 * about queues a task for it in the same transaction (ROUTES); the agents' subscription
 * pushes the row to them. What they and the desk do is written as episode steps, also in
 * the transaction that does it, so the agents panel is a live view of committed work.
 */

export const AGENTS = ['learning', 'scoring', 'exploit', 'access'] as const;
export type AgentName = (typeof AGENTS)[number];

/** Which agents each kind of change wakes, for the client it happened to. */
const ROUTES = {
  /** Cash arrived and was checked. */
  cash_in: ['learning', 'exploit', 'access'],
  /** The bank returned a payment (ACH return): invoices are owed again. */
  payment_returned: ['learning', 'exploit', 'access'],
  dispute: ['learning', 'exploit'],
  /** A cure period or promise expired, broke or was met. */
  deadline: ['exploit', 'access'],
  withdrawal: ['exploit'],
  rm_note: ['access'],
  /** Learning wrote a new credit profile. */
  scored: ['scoring'],
  tier_changed: ['access'],
  exploit_flag: ['access'],
  /** A restriction or restore is live at the platform: Access sends the client its notice. */
  posted: ['access'],
  /** A person decided on an access item (restriction, debit, exception case): Access carries on from there. */
  decided: ['access'],
  /** A client's own policy started failing its success criteria: Scoring proposes a better version. */
  policy_failing: ['scoring'],
  /** A person rejected an agent's proposal: the profile learns from it. */
  override: ['learning'],
  new_client: ['learning'],
  /** Each sim day, for clients with something overdue. */
  daily: ['learning', 'access'],
} as const satisfies Record<string, readonly AgentName[]>;
export type Route = keyof typeof ROUTES;

/** Steps within this long of an episode's last step join it. */
const EPISODE_WINDOW_MICROS = 30_000_000n;
/** A running task with no word for this long is put back in the queue (the agent crashed). */
const STUCK_MICROS = 180_000_000n;
export const MAX_TASK_ATTEMPTS = 3;

export function route(ctx: Ctx, event: Route, clientId: string | undefined, reason: string) {
  if (!clientId) return;
  for (const agent of ROUTES[event]) wake(ctx, agent, clientId, reason);
}

/** Queue a task, or fold the change into the one already queued for this agent and client. */
export function wake(ctx: Ctx, agent: AgentName, clientId: string, reason: string) {
  if (!ctx.db.client.id.find(clientId)) return;
  const episodeId = openEpisode(ctx, clientId)?.id ?? 0n;
  const queued = [...ctx.db.agentTask.clientId.filter(clientId)].find((t) => t.agent === agent && t.status === 'queued');
  if (queued) {
    ctx.db.agentTask.id.update({ ...queued, reason, episodeId: queued.episodeId || episodeId, updatedAt: ctx.timestamp });
    return;
  }
  ctx.db.agentTask.insert({
    id: 0n, agent, clientId, reason, episodeId, status: 'queued', claimedBy: undefined, attempts: 0, summary: '',
    createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
  });
}

/** Called every second by the scheduled tick. */
export function requeueStuckTasks(ctx: Ctx) {
  for (const t of [...ctx.db.agentTask.status.filter('running')]) {
    if (ctx.timestamp.microsSinceUnixEpoch - t.updatedAt.microsSinceUnixEpoch < STUCK_MICROS) continue;
    const failed = t.attempts >= MAX_TASK_ATTEMPTS;
    ctx.db.agentTask.id.update({
      ...t, status: failed ? 'failed' : 'queued', claimedBy: undefined, summary: 'no word from the agent; requeued', updatedAt: ctx.timestamp,
    });
  }
}

// ── Episodes ────────────────────────────────────────────────────────────────

/** The task the caller is running for this client (several agents may share one identity, so `agent` narrows it). */
export function runningTask(ctx: Ctx, clientId: string, agent?: AgentName) {
  let best;
  for (const t of ctx.db.agentTask.clientId.filter(clientId)) {
    if (t.status !== 'running' || !t.claimedBy?.isEqual(ctx.sender) || (agent && t.agent !== agent)) continue;
    if (!best || t.updatedAt.microsSinceUnixEpoch > best.updatedAt.microsSinceUnixEpoch) best = t;
  }
  return best;
}

/** The calling agent's episode for this client, else the client's episode with a step in the last 30 s. */
function openEpisode(ctx: Ctx, clientId: string, agent?: AgentName) {
  const task = runningTask(ctx, clientId, agent);
  if (task?.episodeId) return ctx.db.episode.id.find(task.episodeId);
  let latest;
  for (const e of ctx.db.episode.clientId.filter(clientId)) if (!latest || e.id > latest.id) latest = e;
  if (latest && ctx.timestamp.microsSinceUnixEpoch - latest.updatedAt.microsSinceUnixEpoch <= EPISODE_WINDOW_MICROS) return latest;
  return undefined;
}

export type Actor =
  | 'bank' | 'payment' | 'platform' | 'scheduler' | AgentName | 'guardrail' | 'gateway' | 'person';

export interface StepInput {
  clientId: string | undefined;
  actor: Actor;
  text: string;
  reason?: string;
  checks?: { ok: boolean; label: string }[];
  instead?: string;
  workItemId?: bigint;
  /** Start an episode if none is open (true: titled by the running task's reason, else the step text). */
  opens?: boolean | string;
  /** The agent whose running task this belongs to. */
  agent?: AgentName;
  /** A person must decide (true) or has decided (false). */
  waiting?: boolean;
}

/** Append a step to the client's open episode, starting one when the step is a trigger. */
export function step(ctx: Ctx, s: StepInput) {
  if (!s.clientId || !s.text) return;
  const task = runningTask(ctx, s.clientId, s.agent);
  let ep = (s.workItemId && episodeOfWorkItem(ctx, s.workItemId)) || openEpisode(ctx, s.clientId, s.agent);
  if (!ep) {
    if (!s.opens) return;
    const trigger = humanize(ctx, typeof s.opens === 'string' ? s.opens : task?.reason || s.text);
    ep = ctx.db.episode.insert({
      id: 0n, clientId: s.clientId, trigger, outcome: '', kind: 'auto', startedAt: ctx.timestamp, updatedAt: ctx.timestamp,
    });
  }
  if (task && !task.episodeId) ctx.db.agentTask.id.update({ ...task, episodeId: ep.id });
  const checks = (s.checks ?? []).map((c) => ({ ok: c.ok, label: humanize(ctx, c.label, false) }));
  const text = humanize(ctx, s.text);
  ctx.db.episodeStep.insert({
    id: 0n, episodeId: ep.id, clientId: s.clientId, actor: s.actor, text, reason: humanize(ctx, s.reason ?? ''), checks,
    instead: humanize(ctx, s.instead ?? ''), workItemId: s.workItemId ?? 0n, at: ctx.timestamp,
  });
  const refused = s.actor === 'guardrail' && checks.some((c) => !c.ok);
  const kind = refused ? 'stopped' : s.waiting ? 'waiting' : s.waiting === false && ep.kind === 'waiting' ? 'auto' : ep.kind;
  ctx.db.episode.id.update({ ...ep, kind, outcome: text, updatedAt: ctx.timestamp });
}

function episodeOfWorkItem(ctx: Ctx, workItemId: bigint) {
  for (const st of ctx.db.episodeStep.workItemId.filter(workItemId)) return ctx.db.episode.id.find(st.episodeId);
  return undefined;
}

/** Replace the checks on the step a work item produced (the proposal reducers know them only after creating it). */
export function stepChecks(ctx: Ctx, workItemId: bigint, checks: { ok: boolean; label: string }[], extra?: { waiting?: string }) {
  const st = [...ctx.db.episodeStep.workItemId.filter(workItemId)].pop();
  if (!st) return;
  ctx.db.episodeStep.id.update({ ...st, checks: checks.map((c) => ({ ok: c.ok, label: humanize(ctx, c.label, false) })) });
  if (extra?.waiting) step(ctx, { clientId: st.clientId, actor: 'guardrail', text: extra.waiting, workItemId, waiting: true, checks: [{ ok: true, label: 'routed to a controller' }] });
}

// ── Words, not codes ────────────────────────────────────────────────────────

/** Short names for policies on the panel; a client's own policy versions are "<base>:<client>@<n>". */
const POLICY_LABEL: Record<string, string> = {
  'pol-001': 'matches open invoices',
  'pol-002': 'small short-pay to bank fees',
  'pol-004': 'affiliate pays for the parent',
  'pol-005': 'custody debit allowed',
  'pol-006': 'one step, after the cure period',
  'pol-007': 'reminders need no approval',
  'pol-008': 'hedged book stays open',
  'pol-011': 'released once nothing is overdue',
  'pol-012': 'overpayment kept as credit',
  'pol-013': 'duplicates go back to the sender',
  'pol-015': 'returned payments reopen invoices',
  'pol-020': 'downgrade on score or exploit',
  'pol-021': 'upgrade one tier at a time',
  'pol-022': 'strategic tiers set by a person',
};

/** Payment patterns the detectors name, in words. */
const PATTERN_LABEL: Record<string, string> = {
  restriction_eve: 'pays only on the eve of a restriction',
  partial_reset: 'small partial payments that reset the clock',
  pays_restricted_only: 'pays only the product that was restricted',
  quarter_end: 'holds payments until quarter end',
  recent_late: 'paying later than it used to',
  lateness_jump: 'suddenly paying much later',
  dispute_delay: 'disputes that delay payment',
  withdrawal_during_cure: 'withdrew cash during its cure period',
  paid_mismatch: 'paid amounts that do not match the books',
  prior_overclaimed: 'more credited than billing shows',
  invoice_overapplied: 'more applied than the invoice is worth',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const policyLabel = (ref: string) => (ref.includes(':') ? "the client's own policy" : POLICY_LABEL[ref.split('@')[0]!] ?? 'policy');
const dateLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''} ${Number(iso.slice(8, 10))}`;
const capitalize = (s: string) => (s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s);

/** What the panel shows: names instead of ids, words instead of policy and pattern codes, "Mar 14" instead of ISO dates. */
export function humanize(ctx: Ctx, s: string, sentence = true): string {
  const out = s
    .replace(/^\s*pol-\d{3}(?::ORG-\d+)?(?:@\d+)?:\s*/, '')
    .replace(/\bpol-\d{3}(?::ORG-\d+)?(?:@\d+)?/g, policyLabel)
    .replace(/\bORG-\d+\b/g, (id) => ctx.db.client.id.find(id)?.name ?? 'the client')
    .replace(/\b(\d{4}-\d{2}-\d{2})\b/g, dateLabel)
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (w) => PATTERN_LABEL[w] ?? w.replace(/_/g, ' '))
    .replace(/\b[A-Z]+(?:_[A-Z]+)+\b/g, (w) => w.toLowerCase().replace(/_/g, ' '))
    .trim();
  return sentence ? capitalize(out) : out;
}

// ── Steps from the audit log ────────────────────────────────────────────────

const PAYMENT_KINDS = new Set(['PAYMENT_MATCH', 'REFUND', 'UNAPPLIED_CASH', 'UNIDENTIFIED_CASH', 'PAYMENT_REVERSAL', 'UNEXPLAINED_OUTFLOW']);
const SCORING_KINDS = new Set(['CREDIT_REVIEW', 'POLICY_DRAFT']);
const PEOPLE = new Set(['CONTROLLER', 'ACCOUNTANT', 'RELATIONSHIP_MANAGER', 'ADMIN']);
const DEADLINE_LABEL: Record<string, string> = { cure_period: 'Cure period', promise_to_pay: 'Promised payment', follow_up: 'Follow-up' };

/** Who did it, from the caller's identity. */
function senderActor(ctx: Ctx, agent: AgentName): Actor {
  if (ctx.sender.isEqual(ctx.databaseIdentity)) return 'scheduler';
  const role = actorOf(ctx)?.role ?? '';
  if (role === 'AGENT') return agent;
  if (role === 'SYNC') return 'payment';
  if (role === 'GATEWAY') return 'gateway';
  if (role === 'DEMO' || role === 'CLIENT') return 'platform';
  return PEOPLE.has(role) ? 'person' : 'payment';
}

interface AuditLike {
  action: string;
  subjectId: string;
  clientId?: string;
  workItemId?: bigint;
  fromState?: string;
  toState?: string;
  allowed?: boolean;
  detail?: string;
  policyRef?: string;
}

const scores = (s = '') => s.match(/reliability (\d+) · value (\d+)/);

/**
 * The audit rows worth showing as steps, in words a controller would use. Called by audit(), so
 * every reducer that already audits also narrates; housekeeping (journals, clock, roles) stays out.
 */
export function stepFromAudit(ctx: Ctx, e: AuditLike) {
  const clientId = e.clientId;
  if (!clientId) return;
  const text = e.detail ?? '';
  const policy = e.policyRef ? [{ ok: true, label: e.policyRef }] : [];
  switch (e.action) {
    case 'CASH_IN_TRANSIT':
      return step(ctx, { clientId, actor: 'bank', text, opens: true });
    case 'CASH_RECONCILED':
    case 'APPLICATIONS_REVERSED':
      return step(ctx, { clientId, actor: 'payment', text });
    case 'AUTO_APPLIED':
    case 'PROPOSE': {
      const item = e.workItemId !== undefined ? ctx.db.workItem.id.find(e.workItemId) : undefined;
      if (!item) return;
      // Importing history (first sync, reset) is not news.
      if (PAYMENT_KINDS.has(item.kind) && ctx.db.cashMovement.id.find(item.subjectId)?.isHistory) return;
      const agent: AgentName = SCORING_KINDS.has(item.kind) ? 'scoring' : item.kind === 'EXPLOIT_FLAG' ? 'exploit' : 'access';
      const actor = PAYMENT_KINDS.has(item.kind) ? 'payment' : senderActor(ctx, agent);
      const checks = [...policy, ...(item.autoApplied ? [{ ok: true, label: 'no approval needed' }] : [])];
      return step(ctx, {
        clientId, actor, agent, text: item.title, reason: actor === agent ? item.reasoning : '', checks, workItemId: item.id, opens: true,
        waiting: !item.autoApplied || undefined,
      });
    }
    case 'TRANSITION': {
      const item = e.workItemId !== undefined ? ctx.db.workItem.id.find(e.workItemId) : undefined;
      if (!item || senderActor(ctx, 'access') !== 'person') return;
      if (!e.allowed) return step(ctx, { clientId, actor: 'guardrail', text: `Not allowed: ${text}`, checks: [{ ok: false, label: text }], workItemId: item.id });
      if (e.toState !== 'APPROVED' && e.toState !== 'REJECTED') return;
      const who = actorOf(ctx)?.name ?? 'A controller';
      return step(ctx, {
        clientId, actor: 'person', workItemId: item.id, waiting: false,
        text: `${who} ${e.toState === 'APPROVED' ? 'approved' : 'rejected'}: ${item.title}${e.toState === 'REJECTED' && text ? ` (${text})` : ''}`,
      });
    }
    case 'HOLD_PLACED': {
      const h = ctx.db.hold.id.find(BigInt(e.subjectId));
      const what = h ? `Held ${formatUsd(h.amountCents)} of withdrawals against overdue invoices` : 'Placed a withdrawal hold';
      return step(ctx, { clientId, actor: senderActor(ctx, 'access'), agent: 'access', text: `${what}.`, workItemId: e.workItemId });
    }
    case 'HOLD_RELEASED': {
      const h = ctx.db.hold.id.find(BigInt(e.subjectId));
      return step(ctx, { clientId, actor: senderActor(ctx, 'access'), agent: 'access', text: `Released the ${h ? `${formatUsd(h.amountCents)} ` : ''}hold: nothing is overdue now.`, workItemId: e.workItemId });
    }
    case 'LEVER_SET': {
      const lever = e.subjectId.split(':').pop() ?? '';
      return step(ctx, { clientId, actor: senderActor(ctx, 'access'), agent: 'access', text: `${capitalize(LEVER_LABEL[lever] ?? lever)}: ${text.toLowerCase()}.`, workItemId: e.workItemId });
    }
    case 'DEADLINE_DUE':
    case 'DEADLINE_MET':
    case 'DEADLINE_SET': {
      const d = ctx.db.deadline.id.find(BigInt(e.subjectId));
      if (!d) return;
      const label = DEADLINE_LABEL[d.kind] ?? 'Deadline';
      const clause = d.clause ? [{ ok: true, label: `contract §${d.clause}` }] : [];
      if (e.action === 'DEADLINE_SET') {
        return step(ctx, { clientId, actor: senderActor(ctx, 'access') === 'access' ? 'access' : 'scheduler', agent: 'access', text: `${label} runs until ${dateLabel(d.dueOn)}.`, checks: clause });
      }
      const status = e.toState ?? d.status;
      const words = status === 'met' ? `${label} met: the overdue invoices are paid.`
        : status === 'expired' ? `${label} ended with invoices still overdue.`
        : status === 'broken' ? `${label} did not arrive by ${dateLabel(d.dueOn)}.`
        : `${label} is due.`;
      return step(ctx, { clientId, actor: 'scheduler', text: words, checks: clause, opens: status === 'expired' || status === 'broken' });
    }
    case 'CREDIT_SCORED': {
      const now = scores(e.toState);
      const before = scores(e.fromState);
      if (!now) return;
      const moved = before ? ` (was ${before[1]})` : '';
      return step(ctx, { clientId, actor: 'learning', agent: 'learning', text: `Payment reliability ${now[1]}/100${moved}, value ${now[2]}/100.` });
    }
    case 'TIER_CHANGED':
      return e.allowed === false
        ? step(ctx, { clientId, actor: 'guardrail', text: 'Tier change not applied: the client moved tier in the meantime.', checks: [{ ok: false, label: 'tier changed since the proposal' }], workItemId: e.workItemId })
        : step(ctx, { clientId, actor: 'scoring', agent: 'scoring', text: `Moved from tier ${e.fromState} to tier ${e.toState}.`, checks: policy, workItemId: e.workItemId, opens: true });
    case 'EXPLOIT_FLAGGED': {
      const pattern = e.subjectId.split(':')[0] ?? '';
      return step(ctx, { clientId, actor: 'exploit', agent: 'exploit', text: `Spotted a pattern: ${PATTERN_LABEL[pattern] ?? pattern.replace(/_/g, ' ')}.`, opens: true });
    }
    case 'RM_NOTE':
      return step(ctx, { clientId, actor: 'person', text, opens: `RM note: ${text}` });
    case 'WITHDRAWAL_REQUESTED': {
      const r = ctx.db.accessRequest.id.find(BigInt(e.subjectId));
      const name = ctx.db.client.id.find(clientId)?.name ?? 'The client';
      if (!r) return;
      const asked = `${name} asked to withdraw ${formatUsd(r.amountCents)}.`;
      const outcome = r.allowedCents === r.amountCents ? ' Released in full.'
        : r.allowedCents === 0n ? ` Nothing released: ${r.reason.toLowerCase()}.`
        : ` ${formatUsd(r.allowedCents)} released, ${formatUsd(r.heldCents)} held against overdue invoices.`;
      return step(ctx, { clientId, actor: 'platform', text: asked + outcome, opens: asked });
    }
    case 'AGENT_WAITED': {
      // Scoring records the tiers it kept; everything else that waits is Access.
      const agent: AgentName = /tier/.test(e.toState ?? '') ? 'scoring' : 'access';
      return step(ctx, { clientId, actor: agent, agent, text });
    }
    case 'INVESTIGATED':
      return step(ctx, { clientId, actor: 'access', agent: 'access', text });
  }
}

/** "Wire of $148,200.00 from Zephyr Capital · KST-2207" */
export function arrivalText(m: { rail: string; amountCents: bigint; origName: string; origAccount: string; refs: string[]; direction?: string }) {
  const rail = m.rail === 'USDC' ? 'USDC transfer' : m.rail === 'ACH' ? 'ACH' : m.rail === 'WIRE' ? 'Wire' : m.rail;
  const name = m.origName && m.origName === m.origName.toUpperCase() ? m.origName.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : m.origName;
  const refs = m.refs.length ? ` · ${m.refs.join(', ')}` : '';
  return `${rail} of ${formatUsd(m.amountCents)} ${m.direction === 'out' ? 'to' : 'from'} ${name || m.origAccount}${refs}`;
}
