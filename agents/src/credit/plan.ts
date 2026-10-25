/**
 * What the scoring agent knows before it asks a model anything: the rules' baseline for one
 * client, what is already waiting on a controller, what was recently rejected, how the
 * client's own policies are doing. Pure; the agent supplies the rows.
 */
import { addDays } from './dates';
import { evaluate, parsePolicies, type CompanyPolicy, type Evaluation, type PolicyRow } from './company';
import { BASE_CREDIT_POLICIES, type CompanyContext, type PastDecision } from './decide';
import { detect } from './detectors';
import type { ClientBook, Flag, Scores, TierDecision } from './model';
import { flagsFromRows, viewOf, type FlagRow } from './proposals';
import { decide } from './tiers';

/** A rejected view is not proposed again for this many sim days. */
export const REJECTION_MEMORY_DAYS = 30;
const KINDS = ['CREDIT_REVIEW', 'POLICY_DRAFT'];
const WAITING = ['PROPOSED', 'NEEDS_INFO'];

/** The columns of a work_item row the engine reads. */
export interface WorkItemRow {
  id: bigint;
  kind: string;
  clientId: string;
  subjectId: string;
  state: string;
  proposalJson: string;
}

/** The columns of a precedent row the engine reads. */
export interface PrecedentRow {
  clientId: string;
  workItemId: bigint | undefined;
  decidedOn: string;
  situation: string;
  proposed: string;
  decision: string;
  overrideReason: string;
  outcome: string;
  policyRef: string;
  source: string;
}

export interface Assessment {
  flags: Flag[];
  baseline: TierDecision;
  /** Work waiting on a controller (or a recent rejection) already covers this view: propose nothing. */
  held: boolean;
  /** Open credit reviews that a newer view of this client supersedes. */
  withdraw: WorkItemRow[];
  /** Open work item subjects, so the same proposal is never filed twice. */
  openSubjects: Set<string>;
  ctx: CompanyContext;
}

/** The view a work item was proposed under (older items carry only their subject). */
function viewOfItem(w: WorkItemRow): string {
  try {
    const recorded = (JSON.parse(w.proposalJson || '{}') as { view?: unknown }).view;
    if (typeof recorded === 'string' && recorded) return recorded;
  } catch {
    /* fall through */
  }
  return w.subjectId;
}

/**
 * Items that still stand in the way of a new proposal: anything waiting on a person, and a
 * review a person already decided (strategic clients are not asked twice for the same view).
 * An applied tier change is not one: the client's tier moved, so the view moved with it.
 */
const standing = (w: WorkItemRow) => WAITING.includes(w.state) || (['APPROVED', 'POSTED'].includes(w.state) && w.subjectId.startsWith('review:'));

export function assess(input: {
  book: ClientBook;
  scores: Scores;
  flagRows: FlagRow[];
  workItems: WorkItemRow[];
  precedents: PrecedentRow[];
  /** Every row of the policy table. */
  policies: PolicyRow[];
}): Assessment {
  const { book, scores, flagRows, policies } = input;
  const cid = book.client.id;
  const flags = flagRows.length ? flagsFromRows(book, flagRows) : detect(book);
  const baseline = decide(book, scores, flags);
  const view = viewOf(baseline);

  const rejectedOn = new Map<bigint, string>();
  for (const p of input.precedents) if (p.source === 'live' && p.decision === 'Rejected' && p.workItemId !== undefined) rejectedOn.set(p.workItemId, p.decidedOn);
  const cutoff = addDays(book.today, -REJECTION_MEMORY_DAYS);

  const withdraw: WorkItemRow[] = [];
  const openSubjects = new Set<string>();
  let held = false;
  let openDraft = false;
  for (const w of input.workItems.filter((x) => x.clientId === cid && KINDS.includes(x.kind))) {
    const seen = viewOfItem(w);
    if (standing(w)) {
      const stale = w.kind === 'CREDIT_REVIEW' && WAITING.includes(w.state) && seen !== view;
      if (stale) withdraw.push(w);
      else {
        openSubjects.add(w.subjectId);
        if (seen === view) held = true;
      }
      if (w.kind === 'POLICY_DRAFT' && WAITING.includes(w.state)) openDraft = true;
    } else if (w.state === 'REJECTED' && seen === view && (rejectedOn.get(w.id) ?? '') > cutoff) {
      held = true;
    }
  }

  const mine: CompanyPolicy[] = parsePolicies(policies).filter((p) => p.clientId === cid);
  const evaluations: Evaluation[] = mine.filter((p) => p.status === 'active').map((p) => evaluate(book, p));
  const base = policies.filter((r) => r.policyId in BASE_CREDIT_POLICIES);
  const ctx: CompanyContext = {
    policies: [...base].sort((a, b) => (a.key < b.key ? -1 : 1)).map((r) => ({ id: r.policyId, version: r.version, status: r.status, title: r.title, rule: ruleOf(r.ruleJson) })),
    activePolicyIds: activeIds(policies, cid),
    companyPolicies: mine,
    evaluations,
    precedents: input.precedents.filter((p) => p.clientId === cid && p.source === 'live').map(pastDecision),
    openDraft,
  };
  return { flags, baseline, held, withdraw, openSubjects, ctx };
}

function ruleOf(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function activeIds(rows: PolicyRow[], cid: string): string[] {
  if (!rows.length) return Object.keys(BASE_CREDIT_POLICIES);
  const ids = rows.filter((r) => r.status === 'active' && (r.policyId in BASE_CREDIT_POLICIES || r.policyId.endsWith(`:${cid}`))).map((r) => r.policyId);
  return [...new Set(ids)].sort();
}

const pastDecision = (p: PrecedentRow): PastDecision => ({
  decided_on: p.decidedOn, situation: p.situation, proposed: p.proposed, decision: p.decision, override_reason: p.overrideReason, outcome: p.outcome, policy_ref: p.policyRef,
});
