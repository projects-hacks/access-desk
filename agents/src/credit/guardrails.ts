/**
 * Hard limits on any credit decision, whoever made it. Claude proposes; these checks (pure,
 * deterministic) decide whether the proposal may go any further. The deterministic tier
 * formula is evidence, not a limit: the only limits are the ones below.
 *
 * GUARDRAILS is the list that goes into the prompt; violations() checks a candidate against it.
 */
import { clauseOf, type ClientBook, type Flag, type TierAction, type TierDecision } from './model';

const MIN_TIER = 1;
const MAX_TIER = 5;
const MAX_STEPS_DOWN = 2;
const MAX_STEPS_UP = 1;
export const FLAG_TIER_CAP = 3;
const GRACE_BOUNDS = [0, 15] as const;
const CURE_BOUNDS = [5, 15] as const;
const REMINDER_BOUNDS = [1, 10] as const;
const WINDOW_BOUNDS = [1, 12] as const;
const MAX_DAYS_TARGET = 90;
export const BASE_POLICIES = ['pol-020', 'pol-021', 'pol-022'] as const;

export const LEVERS = ['prepay', 'custody_debit', 'cross_default', 'grace_days', 'cure_days', 'reminder'] as const;
export const METRICS = ['share_paid_within_grace', 'mean_days_late', 'max_days_late', 'pattern_not_firing'] as const;
export const PATTERNS = ['restriction_eve', 'partial_reset', 'pays_restricted_only', 'quarter_end', 'recent_late', 'dispute_delay'] as const;

// ── What the model returns (snake_case: this is the shape stored on proposals) ──

/** One lever. `value` is days for grace_days / cure_days / reminder, else null. */
export interface Term {
  lever: (typeof LEVERS)[number];
  value: number | null;
  at_renewal: boolean;
}

/**
 * A deterministic success test over invoices due after the policy takes effect.
 * share_paid_within_grace: share (0-1) paid within the grace days, passes when >= target.
 * mean_days_late / max_days_late: days, passes when <= target.
 * pattern_not_firing: `pattern` does not fire on the post-policy invoices (target ignored).
 */
export interface Criterion {
  metric: (typeof METRICS)[number];
  target: number;
  pattern: string | null;
  window_months: number;
}

/**
 * `existing`: cite an active policy by id (baseline or this company's own).
 * `company_draft`: a new company-specific version of `policy_id` (a base id such as pol-020,
 * or this company's `pol-020:<client_id>`), drafted for a controller.
 */
export interface PolicyChoice {
  kind: 'existing' | 'company_draft';
  policy_id: string;
  title: string;
  terms: Term[];
  success_criteria: Criterion[];
}

export interface Decision {
  action: TierAction;
  to_tier: number;
  policy: PolicyChoice | null;
  reasons: string[];
  cited_invoice_ids: string[];
  confidence: number;
}

const str = { type: 'string' } as const;
const nullable = (s: Record<string, unknown>) => ({ anyOf: [s, { type: 'null' }] });
const strict = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

/** The Decision as a strict JSON schema (every field required, no extra fields). */
export const DECISION_SCHEMA: Record<string, unknown> = strict({
  action: { type: 'string', enum: ['stay', 'tier_change', 'review'] },
  to_tier: { type: 'integer' },
  policy: nullable(strict({
    kind: { type: 'string', enum: ['existing', 'company_draft'] },
    policy_id: str,
    title: str,
    terms: {
      type: 'array',
      items: strict({ lever: { type: 'string', enum: [...LEVERS] }, value: nullable({ type: 'integer' }), at_renewal: { type: 'boolean' } }),
    },
    success_criteria: {
      type: 'array',
      items: strict({ metric: { type: 'string', enum: [...METRICS] }, target: { type: 'number' }, pattern: nullable(str), window_months: { type: 'integer' } }),
    },
  })),
  reasons: { type: 'array', items: str },
  cited_invoice_ids: { type: 'array', items: str },
  confidence: { type: 'number' },
});

// ── Reading the model's JSON ────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The model's JSON as a Decision, or an Error listing what is wrong with its shape. */
export function parseDecision(raw: unknown): Decision {
  const problems: string[] = [];
  const need = (ok: boolean, path: string, want: string) => {
    if (!ok) problems.push(`schema: ${path}: expected ${want}`);
    return ok;
  };
  const o = isObj(raw) ? raw : {};
  need(isObj(raw), '(root)', 'an object');
  need(['stay', 'tier_change', 'review'].includes(o.action as string), 'action', 'stay, tier_change or review');
  need(Number.isInteger(o.to_tier), 'to_tier', 'an integer');
  need(Array.isArray(o.reasons) && o.reasons.every((r) => typeof r === 'string'), 'reasons', 'a list of strings');
  need(Array.isArray(o.cited_invoice_ids) && o.cited_invoice_ids.every((r) => typeof r === 'string'), 'cited_invoice_ids', 'a list of strings');
  need(typeof o.confidence === 'number', 'confidence', 'a number');
  let policy: PolicyChoice | null = null;
  if (o.policy !== null && o.policy !== undefined) {
    const p = isObj(o.policy) ? o.policy : {};
    if (need(isObj(o.policy), 'policy', 'an object or null')) {
      need(p.kind === 'existing' || p.kind === 'company_draft', 'policy.kind', 'existing or company_draft');
      need(typeof p.policy_id === 'string', 'policy.policy_id', 'a string');
      need(typeof p.title === 'string', 'policy.title', 'a string');
      const terms = Array.isArray(p.terms) ? p.terms : [];
      need(Array.isArray(p.terms), 'policy.terms', 'a list');
      terms.forEach((t, n) => {
        const x = isObj(t) ? t : {};
        need((LEVERS as readonly string[]).includes(x.lever as string), `policy.terms[${n}].lever`, LEVERS.join(', '));
        need(x.value === null || Number.isInteger(x.value), `policy.terms[${n}].value`, 'an integer or null');
        need(typeof x.at_renewal === 'boolean', `policy.terms[${n}].at_renewal`, 'a boolean');
      });
      const criteria = Array.isArray(p.success_criteria) ? p.success_criteria : [];
      need(Array.isArray(p.success_criteria), 'policy.success_criteria', 'a list');
      criteria.forEach((k, n) => {
        const x = isObj(k) ? k : {};
        need((METRICS as readonly string[]).includes(x.metric as string), `policy.success_criteria[${n}].metric`, METRICS.join(', '));
        need(typeof x.target === 'number', `policy.success_criteria[${n}].target`, 'a number');
        need(x.pattern === null || typeof x.pattern === 'string', `policy.success_criteria[${n}].pattern`, 'a string or null');
        need(Number.isInteger(x.window_months), `policy.success_criteria[${n}].window_months`, 'an integer');
      });
      policy = p as unknown as PolicyChoice;
    }
  }
  if (problems.length) throw new Error(problems.slice(0, 8).join('\n'));
  return { ...(o as unknown as Decision), policy };
}

// ── The rules, as the prompt sees them ──────────────────────────────────────

export const GUARDRAILS: { id: string; rule: string }[] = [
  { id: 'tier_range', rule: `to_tier is an integer ${MIN_TIER}..${MAX_TIER} (1 best).` },
  { id: 'action_shape', rule: 'stay and review keep to_tier = current tier; tier_change moves it.' },
  { id: 'max_down', rule: `At most ${MAX_STEPS_DOWN} steps worse per proposal.` },
  { id: 'max_up', rule: `At most ${MAX_STEPS_UP} step better per proposal.` },
  { id: 'strategic', rule: 'Strategic client: never tier_change; use review (pol-022).' },
  { id: 'recent_late', rule: 'No upgrade while recent_late is fired.' },
  { id: 'flag_cap', rule: `Any fired flag: a tier_change may not go better than tier ${FLAG_TIER_CAP}.` },
  { id: 'lever_prepay', rule: 'prepay only if the contract has an allowed `prepay` clause.' },
  { id: 'lever_debit', rule: 'custody_debit only if the contract has an allowed `debit` clause.' },
  { id: 'lever_cross_default', rule: "cross_default only as a renewal term (at_renewal true), and only if the contract doesn't already have it." },
  { id: 'lever_grace', rule: `grace_days only as a renewal term, value ${GRACE_BOUNDS[0]}..${GRACE_BOUNDS[1]}.` },
  { id: 'lever_cure', rule: `cure_days only as a renewal term, value ${CURE_BOUNDS[0]}..${CURE_BOUNDS[1]}.` },
  { id: 'lever_reminder', rule: `reminder: days before due, value ${REMINDER_BOUNDS[0]}..${REMINDER_BOUNDS[1]}; may apply now.` },
  { id: 'lever_value', rule: 'value is null for prepay, custody_debit, cross_default.' },
  { id: 'policy_exists', rule: 'existing: policy_id must be one of the active policies listed.' },
  { id: 'draft_shape', rule: `company_draft: policy_id is a base id ${BASE_POLICIES.join(', ')} or <base>:<client_id> for this client; a title, 1+ terms and 1+ success criteria.` },
  { id: 'one_open_draft', rule: 'No company_draft while one for this client waits on a controller.' },
  { id: 'criteria', rule: `share target 0..1; days targets 0..${MAX_DAYS_TARGET}; pattern_not_firing names a known pattern; window_months ${WINDOW_BOUNDS[0]}..${WINDOW_BOUNDS[1]}.` },
  { id: 'citations', rule: 'Every cited invoice id appears in the facts; a tier_change or company_draft cites at least one.' },
  { id: 'confidence', rule: 'confidence is 0..1.' },
  { id: 'reasons', rule: 'At least one reason.' },
];

export const firedPatterns = (flags: Flag[]) => flags.filter((f) => f.fired).map((f) => f.pattern);

const allowed = (book: ClientBook, kind: string) => !!clauseOf(book, kind)?.allowed;

/** The client-specific guardrails, in words (shown to Claude and to the controller). */
export function applicable(book: ClientBook, flags: Flag[]): string[] {
  const c = book.client;
  const out: string[] = [];
  if (c.strategic) out.push('strategic: review only, no tier change');
  const patterns = firedPatterns(flags);
  if (patterns.length) out.push(`flag cap: ${patterns.join(', ')} fired, tier no better than ${FLAG_TIER_CAP}`);
  if (patterns.includes('recent_late')) out.push('no upgrade: recent_late fired');
  out.push(`tier from ${c.tier}: ${Math.max(MIN_TIER, c.tier - MAX_STEPS_UP)}..${Math.min(MAX_TIER, c.tier + MAX_STEPS_DOWN)}`);
  out.push(`prepay ${allowed(book, 'prepay') ? 'allowed' : 'not in contract'}; custody debit ${allowed(book, 'debit') ? 'allowed' : 'not allowed'}`);
  out.push(`cross-default ${book.contract.crossDefault ? 'already signed' : 'only at renewal'}`);
  out.push(`grace/cure changes only at renewal${c.renewalOn ? ` (${c.renewalOn})` : ''}`);
  return out;
}

/** Every rule the candidate breaks, as `<guardrail id>: <why>`. Empty means allowed. */
export function violations(book: ClientBook, flags: Flag[], d: Decision, evidenceIds: Set<string>, activePolicyIds: Set<string>, openDraft = false): string[] {
  const c = book.client;
  const current = c.tier;
  const out: string[] = [];

  if (d.to_tier < MIN_TIER || d.to_tier > MAX_TIER) out.push(`tier_range: to_tier ${d.to_tier} is outside ${MIN_TIER}..${MAX_TIER}`);
  if ((d.action === 'stay' || d.action === 'review') && d.to_tier !== current) out.push(`action_shape: ${d.action} must keep tier ${current}, not ${d.to_tier}`);
  if (d.action === 'tier_change') {
    if (d.to_tier === current) out.push(`action_shape: tier_change to the current tier ${current}`);
    if (d.to_tier - current > MAX_STEPS_DOWN) out.push(`max_down: ${d.to_tier - current} steps down from ${current} to ${d.to_tier}; at most ${MAX_STEPS_DOWN}`);
    if (current - d.to_tier > MAX_STEPS_UP) out.push(`max_up: ${current - d.to_tier} steps up from ${current} to ${d.to_tier}; at most ${MAX_STEPS_UP}`);
    if (c.strategic) out.push(`strategic: ${c.name} is strategic; propose a review, not a tier change`);
    const patterns = firedPatterns(flags);
    if (d.to_tier < current && patterns.includes('recent_late')) out.push('recent_late: no upgrade while recent_late is fired');
    if (patterns.length && d.to_tier < FLAG_TIER_CAP) out.push(`flag_cap: ${patterns.join(', ')} fired; tier ${d.to_tier} is better than ${FLAG_TIER_CAP}`);
  }

  if (d.policy) out.push(...policyViolations(book, d.policy, activePolicyIds, openDraft));

  const unknown = d.cited_invoice_ids.filter((i) => !evidenceIds.has(i));
  if (unknown.length) out.push(`citations: not in the facts: ${unknown.join(', ')}`);
  const drafting = d.policy?.kind === 'company_draft';
  if ((d.action === 'tier_change' || drafting) && !d.cited_invoice_ids.length) out.push('citations: a tier change or company policy must cite at least one invoice');
  if (!(d.confidence >= 0 && d.confidence <= 1)) out.push(`confidence: ${d.confidence} is outside 0..1`);
  if (!d.reasons.some((r) => r.trim())) out.push('reasons: give at least one reason');
  return out;
}

function policyViolations(book: ClientBook, p: PolicyChoice, active: Set<string>, openDraft: boolean): string[] {
  const cid = book.client.id;
  const out: string[] = [];
  if (p.kind === 'existing') {
    if (!active.has(p.policy_id)) out.push(`policy_exists: ${p.policy_id} is not an active policy`);
    if (p.terms.length || p.success_criteria.length) out.push('policy_exists: an existing policy carries no new terms or criteria; use company_draft');
    return out;
  }
  const base = p.policy_id.split(':', 1)[0] ?? '';
  const owner = p.policy_id.includes(':') ? p.policy_id.slice(p.policy_id.indexOf(':') + 1) : '';
  if (!(BASE_POLICIES as readonly string[]).includes(base) || (owner && owner !== cid)) {
    out.push(`draft_shape: ${p.policy_id} must be one of ${BASE_POLICIES.join(', ')} or <base>:${cid}`);
  }
  if (!p.title.trim()) out.push('draft_shape: a company policy needs a title');
  if (!p.terms.length) out.push('draft_shape: a company policy needs at least one term');
  if (!p.success_criteria.length) out.push('draft_shape: a company policy needs at least one success criterion');
  if (openDraft) out.push(`one_open_draft: a policy draft for ${cid} already waits on a controller`);
  for (const t of p.terms) out.push(...termViolations(book, t));
  for (const k of p.success_criteria) out.push(...criterionViolations(k));
  return out;
}

function termViolations(book: ClientBook, t: Term): string[] {
  const out: string[] = [];
  const needsValue = t.lever === 'grace_days' || t.lever === 'cure_days' || t.lever === 'reminder';
  if (needsValue && t.value === null) out.push(`lever_value: ${t.lever} needs a value in days`);
  if (!needsValue && t.value !== null) out.push(`lever_value: ${t.lever} takes no value`);
  if (t.lever === 'prepay' && !allowed(book, 'prepay')) out.push('lever_prepay: the contract has no allowed prepay clause');
  if (t.lever === 'custody_debit' && !allowed(book, 'debit')) out.push("lever_debit: the contract doesn't allow custody debits");
  if (t.lever === 'cross_default') {
    if (!t.at_renewal) out.push('lever_cross_default: cross-default only as a renewal term');
    if (book.contract.crossDefault) out.push('lever_cross_default: the contract already has cross-default');
  }
  const bounds: [string, readonly [number, number], string][] = [
    ['grace_days', GRACE_BOUNDS, 'lever_grace'],
    ['cure_days', CURE_BOUNDS, 'lever_cure'],
    ['reminder', REMINDER_BOUNDS, 'lever_reminder'],
  ];
  for (const [lever, [lo, hi], gid] of bounds) {
    if (t.lever !== lever) continue;
    if (lever !== 'reminder' && !t.at_renewal) out.push(`${gid}: ${lever} changes only as a renewal term`);
    if (t.value !== null && (t.value < lo || t.value > hi)) out.push(`${gid}: ${lever} ${t.value} is outside ${lo}..${hi}`);
  }
  return out;
}

function criterionViolations(k: Criterion): string[] {
  const out: string[] = [];
  if (k.metric === 'share_paid_within_grace' && !(k.target >= 0 && k.target <= 1)) out.push(`criteria: share target ${k.target} is outside 0..1`);
  if ((k.metric === 'mean_days_late' || k.metric === 'max_days_late') && !(k.target >= 0 && k.target <= MAX_DAYS_TARGET)) {
    out.push(`criteria: ${k.metric} target ${k.target} is outside 0..${MAX_DAYS_TARGET}`);
  }
  if (k.metric === 'pattern_not_firing' && !(PATTERNS as readonly string[]).includes(k.pattern ?? '')) out.push(`criteria: unknown pattern ${k.pattern}`);
  if (k.window_months < WINDOW_BOUNDS[0] || k.window_months > WINDOW_BOUNDS[1]) out.push(`criteria: window_months ${k.window_months} is outside ${WINDOW_BOUNDS[0]}..${WINDOW_BOUNDS[1]}`);
  return out;
}

/** The deterministic decision in the model's shape (cites the policy it used, no new terms). */
export function fromBaseline(d: TierDecision): Decision {
  return {
    action: d.action,
    to_tier: d.toTier,
    policy: d.policyRef ? { kind: 'existing', policy_id: d.policyRef, title: '', terms: [], success_criteria: [] } : null,
    reasons: d.reasons,
    cited_invoice_ids: [],
    confidence: d.confidence,
  };
}
