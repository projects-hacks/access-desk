/** What the scoring agent files: CREDIT_REVIEW and POLICY_DRAFT proposals, and the facts they carry. */
import { companyPolicyId, nextVersion, ruleJson, type PolicyRow } from './company';
import { draftOf, type Outcome } from './decide';
import type { PolicyChoice } from './guardrails';
import { proposalNumbers, type ClientBook, type Evidence, type Flag, type Scores, type TierDecision } from './model';
import { template } from './reasoning';

/** The arguments of `propose_work_item`, before they are turned into reducer parameters. */
export interface Proposal {
  kind: 'CREDIT_REVIEW' | 'POLICY_DRAFT';
  clientId: string;
  subjectId: string;
  title: string;
  amountCents: number;
  proposal: Record<string, unknown>;
  reasoning: string;
  policyRef: string;
  confidence: number;
  requiredRole: 'CONTROLLER';
}

/** The columns of an exploit_flag row the engine reads (ExploitWatch writes them). */
export interface FlagRow {
  id: string;
  pattern: string;
  score: number;
  status: string;
  months: number;
  evidenceJson: string;
  proposedFix: string;
}

export function subjectOf(d: TierDecision): string | undefined {
  if (d.action === 'tier_change') return `tier:${d.clientId}:${d.current}->${d.toTier}`;
  if (d.action === 'review') return `review:${d.clientId}`;
  return undefined;
}

/** The rules' view of a client; a new view lets the client be decided again. */
export const viewOf = (d: TierDecision) => subjectOf(d) ?? `stay:${d.clientId}`;

/** ExploitWatch's rows for this client as flags; `cleared` rows don't count. */
export function flagsFromRows(book: ClientBook, rows: FlagRow[]): Flag[] {
  const invoices = new Map(book.invoices.map((i) => [i.id, i]));
  const out: Flag[] = [];
  for (const r of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (r.status === 'cleared') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(r.evidenceJson || '[]');
    } catch {
      raw = [];
    }
    const evidence: Evidence[] = [];
    for (const e of Array.isArray(raw) ? raw : []) {
      const inv = e && typeof e === 'object' ? invoices.get(String((e as Record<string, unknown>).invoice_id ?? '')) : undefined;
      if (!inv) continue;
      const x = e as Record<string, unknown>;
      const late = Math.round((Date.parse(inv.paidOn ?? book.today) - Date.parse(inv.dueOn)) / 86_400_000);
      evidence.push({
        invoiceId: inv.id, dueOn: inv.dueOn, paidOn: inv.paidOn,
        dpd: x.dpd != null && Number.isFinite(Number(x.dpd)) ? Math.trunc(Number(x.dpd)) : Math.max(0, late),
        note: String(x.note ?? ''),
      });
    }
    out.push({
      pattern: r.pattern, fired: true,
      measured: `flagged by ExploitWatch (${r.status}, ${r.months} months, score ${r.score.toFixed(2)})`,
      evidence, months: r.months, score: Math.round(r.score * 1000) / 1000, proposedFix: r.proposedFix,
    });
  }
  return out;
}

/** The audit code and reason for a tier the model kept against the rules' proposal, if it did. */
export function keptTier(book: ClientBook, o: Outcome): { code: string; reason: string } | undefined {
  if (o.decidedBy !== 'claude' || o.baseline.action === 'stay' || o.final.action !== 'stay') return undefined;
  const base = o.baseline;
  const wanted = base.action === 'tier_change' ? `tier ${base.current} -> ${base.toTier}` : 'a review';
  const why = o.choice?.reasons[0] ?? 'no reason given';
  return {
    code: `claude_kept_tier:${base.action}:${base.toTier}`,
    reason: `Claude kept tier ${base.current}; the rules proposed ${wanted}. ${why}`.slice(0, 480),
  };
}

function decisionMeta(o: Outcome) {
  const b = o.baseline;
  return {
    decided_by: o.decidedBy,
    provider: o.provider,
    ...(o.model ? { model: o.model } : {}),
    why: o.why,
    view: viewOf(b),
    baseline: { action: b.action, to_tier: b.toTier, policy_ref: b.policyRef, confidence: b.confidence, reasons: b.reasons },
    choice: o.choice,
    guardrails: o.guardrails,
    rejected_attempts: o.attempts.filter((a) => a.violations.length || a.error),
  };
}

function reasoningOf(scores: Scores, flags: Flag[], o: Outcome): string {
  if (o.decidedBy === 'rules' || !o.choice) return template(o.final, scores, flags);
  const d = o.choice;
  const base = o.baseline;
  const cited = d.cited_invoice_ids.slice(0, 10).join(', ') + (d.cited_invoice_ids.length > 10 ? ` and ${d.cited_invoice_ids.length - 10} more` : '');
  const rules = { tier_change: `tier ${base.current} -> ${base.toTier}`, review: 'a review', stay: `keep tier ${base.current}` }[base.action];
  const parts = [d.reasons.join(' ')];
  if (cited) parts.push(`Evidence: ${cited}.`);
  parts.push(`The rules alone would ${base.action !== 'stay' ? 'propose ' : ''}${rules}.`);
  return parts.join(' ');
}

export function reviewProposal(book: ClientBook, scores: Scores, flags: Flag[], o: Outcome, subject: string): Proposal {
  const d = o.final;
  const name = book.client.name;
  const title = d.action === 'tier_change' ? `${name}: tier ${d.current} → ${d.toTier}` : book.client.strategic ? `${name}: review strategic tier` : `${name}: review tier`;
  return {
    kind: 'CREDIT_REVIEW', clientId: book.client.id, subjectId: subject, title, amountCents: scores.exposureCents,
    proposal: { ...proposalNumbers(d, scores, flags), ...decisionMeta(o) }, reasoning: reasoningOf(scores, flags, o),
    policyRef: d.policyRef, confidence: d.confidence, requiredRole: 'CONTROLLER',
  };
}

const termText = (lever: string, value: number | null, atRenewal: boolean) =>
  `${lever.replaceAll('_', ' ')}${value !== null ? ` ${value} days` : ''}${atRenewal ? ' at renewal' : ''}`;

function criterionText(metric: string, target: number, pattern: string | null, months: number): string {
  if (metric === 'pattern_not_firing') return `${pattern} stops firing within ${months} months`;
  const op = metric === 'share_paid_within_grace' ? '>=' : '<=';
  return `${metric.replaceAll('_', ' ')} ${op} ${Number(target.toPrecision(6))} over ${months} months`;
}

/** The policy row to save as a draft, and the proposal that asks a controller to activate it. */
export function policyDraft(book: ClientBook, scores: Scores, o: Outcome, rows: PolicyRow[], today: string) {
  const p = draftOf(o) as PolicyChoice;
  const d = o.choice as NonNullable<Outcome['choice']>;
  const cid = book.client.id;
  const policyId = companyPolicyId(p, cid);
  const version = nextVersion(rows, policyId);
  const rule = ruleJson(p, cid, today);
  const learned = `${d.reasons.join('; ')} Evidence: ${d.cited_invoice_ids.join(', ')}.`;
  const key = `${policyId}@${version}`;
  const terms = p.terms.map((t) => termText(t.lever, t.value, t.at_renewal)).join('; ');
  const proposal: Proposal = {
    kind: 'POLICY_DRAFT', clientId: cid, subjectId: `policy:${key}`, title: `${book.client.name}: ${p.title}`, amountCents: scores.exposureCents,
    proposal: { policy_key: key, policy_id: policyId, version, title: p.title, rule, ...decisionMeta(o) },
    reasoning: `${learned} Terms: ${terms}. Success: ${p.success_criteria.map((k) => criterionText(k.metric, k.target, k.pattern, k.window_months)).join('; ')}.`,
    policyRef: policyId, confidence: d.confidence, requiredRole: 'CONTROLLER',
  };
  return { policyId, version, title: p.title, ruleJson: JSON.stringify(rule), learnedFrom: learned, proposal };
}
