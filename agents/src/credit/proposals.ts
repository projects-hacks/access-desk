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
  const wanted = base.action === 'tier_change' ? `a move to tier ${base.toTier}` : 'a review';
  const why = o.choice?.reasons[0] ?? 'no reason given';
  return {
    code: `claude_kept_tier:${base.action}:${base.toTier}`,
    reason: `Kept tier ${base.current}; the rules proposed ${wanted}. ${why}`.slice(0, 480),
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

/** One point per line, each a short plain sentence: the console shows them as bullets. */
const bulletLines = (lines: string[]) => lines.map(plainSentence).filter(Boolean).map((l) => `- ${l}`).join('\n');

/** A model's sentence in the desk's voice: no dashes for punctuation, no stray separators. */
export function plainSentence(text: string): string {
  const t = text
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/;\s+(\w)/g, (_m, c: string) => `. ${c.toUpperCase()}`)
    .replace(/\s*;\s*$/, '')
    .replace(/\.;/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!t) return '';
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

const invoiceList = (ids: string[]) => ids.slice(0, 6).join(', ') + (ids.length > 6 ? ` and ${ids.length - 6} more` : '');

function reasoningOf(scores: Scores, flags: Flag[], o: Outcome): string {
  if (o.decidedBy === 'rules' || !o.choice) return template(o.final, scores, flags);
  const d = o.choice;
  const base = o.baseline;
  const rules = { tier_change: `move to tier ${base.toTier}`, review: 'ask for a review', stay: `keep tier ${base.current}` }[base.action];
  return bulletLines([
    ...d.reasons,
    ...(d.cited_invoice_ids.length ? [`Invoices: ${invoiceList(d.cited_invoice_ids)}`] : []),
    `The rules alone would ${rules}`,
  ]);
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

function termText(lever: string, value: number | null, atRenewal: boolean): string {
  const when = atRenewal ? ' at renewal' : '';
  switch (lever) {
    case 'reminder': return `Reminder ${value} days before each due date${when}`;
    case 'grace_days': return `Grace period of ${value} days${when}`;
    case 'cure_days': return `Cure period of ${value} days${when}`;
    case 'prepay': return `Prepay required${when}`;
    case 'custody_debit': return `Overdue fees collected from custody${when}`;
    case 'cross_default': return `Cross-default across products${when}`;
    default: return `${lever.replaceAll('_', ' ')}${value !== null ? ` ${value} days` : ''}${when}`;
  }
}

/** The detectors' patterns, as a controller would name them. */
const PATTERN_WORDS: Record<string, string> = {
  restriction_eve: 'payments timed to the day before a restriction',
  partial_reset: 'small partial payments that reset the clock',
  pays_restricted_only: 'paying only the restricted product',
  quarter_end: 'payments held back until quarter end',
  recent_late: 'late payments',
  lateness_jump: 'late payments',
  dispute_delay: 'disputes that delay payment',
};

function criterionText(metric: string, target: number, pattern: string | null, months: number): string {
  const over = `over ${months} ${months === 1 ? 'month' : 'months'}`;
  if (metric === 'pattern_not_firing') return `no more ${PATTERN_WORDS[pattern ?? ''] ?? (pattern ?? 'of the pattern').replaceAll('_', ' ')} ${over}`;
  if (metric === 'share_paid_within_grace') return target >= 1 ? `every invoice paid within grace ${over}` : `${Math.round(target * 100)}% of invoices paid within grace ${over}`;
  if (metric === 'mean_days_late') return `average lateness of ${Number(target.toPrecision(3))} days or less ${over}`;
  if (metric === 'max_days_late') return `no invoice more than ${Number(target.toPrecision(3))} days late ${over}`;
  return `${metric.replaceAll('_', ' ')} at ${Number(target.toPrecision(6))} ${over}`;
}

/** The policy row to save as a draft, and the proposal that asks a controller to activate it. */
export function policyDraft(book: ClientBook, scores: Scores, o: Outcome, rows: PolicyRow[], today: string) {
  const p = draftOf(o) as PolicyChoice;
  const d = o.choice as NonNullable<Outcome['choice']>;
  const cid = book.client.id;
  const policyId = companyPolicyId(p, cid);
  const version = nextVersion(rows, policyId);
  const rule = ruleJson(p, cid, today);
  const key = `${policyId}@${version}`;
  const learned = [...d.reasons.map(plainSentence), ...(d.cited_invoice_ids.length ? [`Invoices: ${invoiceList(d.cited_invoice_ids)}.`] : [])].join(' ');
  const proposal: Proposal = {
    kind: 'POLICY_DRAFT', clientId: cid, subjectId: `policy:${key}`, title: `${book.client.name}: ${p.title}`, amountCents: scores.exposureCents,
    proposal: { policy_key: key, policy_id: policyId, version, title: p.title, rule, ...decisionMeta(o) },
    reasoning: bulletLines([
      ...d.reasons,
      ...(d.cited_invoice_ids.length ? [`Invoices: ${invoiceList(d.cited_invoice_ids)}`] : []),
      ...p.terms.map((t) => `Change: ${termText(t.lever, t.value, t.at_renewal).toLowerCase()}`),
      ...p.success_criteria.map((k) => `Works if: ${criterionText(k.metric, k.target, k.pattern, k.window_months)}`),
    ]),
    policyRef: policyId, confidence: d.confidence, requiredRole: 'CONTROLLER',
  };
  return { policyId, version, title: p.title, ruleJson: JSON.stringify(rule), learnedFrom: learned, proposal };
}
