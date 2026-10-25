/**
 * Company-specific policies (`pol-020:ORG-90677`, versioned) and their deterministic evaluator.
 * A controller activates a version; from its `effective_on` the evaluator measures the success
 * criteria on the invoices due since. A failing policy is fed back into the next decision for
 * that company: that is the learning loop.
 */
import { addDays, daysBetween } from './dates';
import { DETECTORS } from './detectors';
import type { Criterion, PolicyChoice } from './guardrails';
import type { ClientBook, Invoice } from './model';

/** Fewer invoices due since the policy took effect: no verdict yet. */
const MIN_INVOICES = 2;

/** The columns of a policy row the engine reads. */
export interface PolicyRow {
  key: string;
  policyId: string;
  version: number;
  status: string;
  title: string;
  ruleJson: string;
}

export interface CompanyPolicy {
  key: string;
  policyId: string;
  version: number;
  status: string;
  title: string;
  clientId: string;
  rule: Record<string, unknown>;
  effectiveOn: string | null;
  workItemId: number | null;
  criteria: Criterion[];
}

export interface CriterionResult {
  metric: string;
  target: number;
  pattern: string | null;
  measured: number | null;
  invoices: number;
  passed: boolean | null;
  text: string;
}

export interface Evaluation {
  policy_key: string;
  client_id: string;
  status: 'pending' | 'passing' | 'failing';
  results: CriterionResult[];
}

export const outcomeText = (e: Evaluation, today: string) => `${e.status} on ${today}: ${e.results.map((r) => r.text).join('; ')}`;

/** The client a `<base>:<client>` policy id belongs to. */
export const clientOf = (policyId: string) => (policyId.includes(':') ? policyId.slice(policyId.indexOf(':') + 1) : undefined) || undefined;

/** Company-specific policy rows (policy id `<base>:<client>`); malformed rows are skipped. */
export function parsePolicies(rows: PolicyRow[]): CompanyPolicy[] {
  const out: CompanyPolicy[] = [];
  for (const r of rows) {
    const owner = clientOf(r.policyId);
    if (!owner) continue;
    try {
      const rule = JSON.parse(r.ruleJson || '{}') as Record<string, unknown>;
      const eff = rule.effective_on;
      out.push({
        key: r.key, policyId: r.policyId, version: r.version, status: r.status, title: r.title, clientId: owner, rule,
        effectiveOn: typeof eff === 'string' && eff ? eff : null,
        workItemId: rule.work_item_id ? Number(rule.work_item_id) : null,
        criteria: Array.isArray(rule.success_criteria) ? (rule.success_criteria as Criterion[]) : [],
      });
    } catch {
      /* skipped */
    }
  }
  return out.sort((a, b) => (a.policyId === b.policyId ? a.version - b.version : a.policyId < b.policyId ? -1 : 1));
}

/** A draft that never reached a controller is overwritten; otherwise one past the latest. */
export function nextVersion(rows: PolicyRow[], policyId: string): number {
  const mine = rows.filter((r) => r.policyId === policyId);
  if (!mine.length) return 1;
  const latest = mine.reduce((a, b) => (b.version > a.version ? b : a));
  return latest.version + (latest.status === 'draft' ? 0 : 1);
}

export const companyPolicyId = (choice: PolicyChoice, clientId: string) => `${choice.policy_id.split(':', 1)[0]}:${clientId}`;

export function ruleJson(choice: PolicyChoice, clientId: string, proposedOn: string) {
  return {
    client_id: clientId,
    base: choice.policy_id.split(':', 1)[0],
    terms: choice.terms,
    success_criteria: choice.success_criteria,
    proposed_on: proposedOn,
  };
}

const lagOf = (i: Invoice, today: string) => daysBetween(i.dueOn, i.paidOn ?? today);

/** Pure: the policy's criteria on invoices due since it took effect (grace elapsed). */
export function evaluate(book: ClientBook, policy: CompanyPolicy): Evaluation {
  const grace = book.contract.graceDays;
  const results: CriterionResult[] = [];
  for (const k of policy.criteria) {
    if (policy.effectiveOn === null) {
      results.push(result(k, null, 0, 'not active yet'));
      continue;
    }
    const end = addDays(policy.effectiveOn, Math.round(k.window_months * 30.44));
    const effective = policy.effectiveOn;
    const window = book.invoices.filter(
      (i) => i.dueOn >= effective && i.dueOn <= end && i.status !== 'void' && (i.paidOn !== null || addDays(i.dueOn, grace) < book.today),
    );
    results.push(measure(book, k, window, grace));
  }
  const failing = results.some((r) => r.passed === false);
  const pending = !results.length || results.some((r) => r.passed === null);
  return { policy_key: policy.key, client_id: policy.clientId, status: failing ? 'failing' : pending ? 'pending' : 'passing', results };
}

function measure(book: ClientBook, k: Criterion, window: Invoice[], grace: number): CriterionResult {
  const n = window.length;
  if (n < MIN_INVOICES) return result(k, null, n, `${k.metric}: ${n} invoices due since, too few to judge`);
  const lags = window.map((i) => Math.max(0, lagOf(i, book.today)));
  const target = Number(k.target.toPrecision(6));
  if (k.metric === 'share_paid_within_grace') {
    const onTime = window.filter((i) => i.paidOn && lagOf(i, book.today) <= grace).length;
    const share = onTime / n;
    return result(k, share, n, `${onTime} of ${n} paid within ${grace} days (${share.toFixed(2)} vs >= ${target})`, share >= k.target);
  }
  if (k.metric === 'mean_days_late') {
    const m = lags.reduce((a, b) => a + b, 0) / n;
    return result(k, m, n, `mean ${m.toFixed(1)} days late over ${n} invoices (<= ${target})`, m <= k.target);
  }
  if (k.metric === 'max_days_late') {
    const worst = Math.max(...lags);
    return result(k, worst, n, `worst ${worst} days late over ${n} invoices (<= ${target})`, worst <= k.target);
  }
  const detector = k.pattern ? DETECTORS[k.pattern] : undefined;
  if (!detector) return result(k, null, n, `unknown pattern ${k.pattern}`);
  const ids = new Set(window.map((i) => i.id));
  const flag = detector({ ...book, invoices: window, disputes: book.disputes.filter((d) => ids.has(d.invoiceId)) });
  return result(k, flag.fired ? 1 : 0, n, `${k.pattern} ${flag.fired ? 'still fires' : 'does not fire'} on ${n} invoices since (${flag.measured})`, !flag.fired);
}

function result(k: Criterion, measured: number | null, n: number, text: string, passed: boolean | null = null): CriterionResult {
  return { metric: k.metric, target: k.target, pattern: k.pattern, measured: measured === null ? null : Math.round(measured * 1000) / 1000, invoices: n, passed, text };
}
