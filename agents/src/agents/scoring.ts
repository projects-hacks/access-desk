import { decideCompany, draftOf } from '../credit/decide';
import { loadBilling, loadBook } from '../credit/load';
import { assess } from '../credit/plan';
import { keptTier, policyDraft, reviewProposal, subjectOf, type Proposal } from '../credit/proposals';
import { scoreBook } from '../credit/scoring';
import type { DbConnection } from '../module_bindings';
import type { Agent, TaskContext } from '../types';

/** The reducer arguments for a proposal (propose_work_item). */
const proposeArgs = (p: Proposal) => ({
  kind: p.kind, clientId: p.clientId, subjectId: p.subjectId, title: p.title, amountCents: BigInt(Math.round(p.amountCents)),
  proposalJson: JSON.stringify(p.proposal), reasoning: p.reasoning, policyRef: p.policyRef, clausesCited: [], boundariesJson: '[]',
  confidence: p.confidence, requiredRole: p.requiredRole,
});

/** Whether a tier kept against the rules was already recorded for this client (the audit log is the memory). */
const alreadyKept = (conn: DbConnection, clientId: string, code: string) =>
  [...conn.db.auditEvent.clientId.filter(clientId)].some((a) => a.action === 'AGENT_WAITED' && a.toState === code);

/**
 * Decides one client's tier when its credit profile moves: the rules' baseline, the exploit
 * flags, then Droid (or Claude) within the guardrails, falling back to the rules. Files a
 * CREDIT_REVIEW proposal for a change or review, and a POLICY_DRAFT when the model drafts
 * company terms; files nothing when the tier stays.
 */
export const scoring: Agent = {
  name: 'scoring',
  concurrency: 4,
  async handle(ctx: TaskContext) {
    const { conn, today } = ctx;
    const clientId = ctx.task.clientId;
    const book = loadBook(conn, clientId, today);
    if (!book) return 'unknown client';
    const scores = scoreBook(book, loadBilling(conn, today));
    const name = book.client.name;

    const a = assess({
      book, scores,
      flagRows: [...conn.db.exploitFlag.clientId.filter(clientId)],
      workItems: [...conn.db.workItem.clientId.filter(clientId)],
      precedents: [...conn.db.precedent.clientId.filter(clientId)],
      policies: [...conn.db.policy.iter()],
    });

    for (const w of a.withdraw) {
      await ctx.attempt(`withdraw the earlier review of ${name}`, () => conn.reducers.transitionWorkItem({ workItemId: w.id, toState: 'WITHDRAWN', note: 'superseded by a newer credit review' }));
    }
    if (a.withdraw.length) await ctx.say(`Withdrew the open review of ${name}: the books have moved on since it was filed.`);
    if (a.held) return 'nothing new: an open or recently rejected proposal already covers this';

    const o = await decideCompany({ book, scores, flags: a.flags, baseline: a.baseline, ctx: a.ctx }, ctx.ask);
    const final = o.final;

    const kept = keptTier(book, o);
    if (kept && !alreadyKept(conn, clientId, kept.code)) {
      await ctx.attempt(`note that ${name}'s tier was kept`, () => conn.reducers.recordWait({ clientId, code: kept.code, reason: kept.reason }));
    }

    const notes: string[] = [];
    const subject = subjectOf(final);
    if (subject && !a.openSubjects.has(subject)) {
      const p = reviewProposal(book, scores, a.flags, o, subject);
      if (!(await ctx.attempt(`propose: ${p.title}`, () => conn.reducers.proposeWorkItem(proposeArgs(p))))) {
        notes.push(final.action === 'tier_change' ? `tier ${final.current} → ${final.toTier} proposed` : 'tier review proposed');
      }
    }
    if (draftOf(o) && !a.ctx.openDraft) {
      const d = policyDraft(book, scores, o, [...conn.db.policy.iter()], today);
      const saved = await ctx.attempt(`save the draft policy ${d.policyId}`, () =>
        conn.reducers.upsertPolicy({ policyId: d.policyId, version: d.version, status: 'draft', title: d.title, ruleJson: d.ruleJson, learnedFrom: d.learnedFrom, approvedBy: undefined }));
      if (!saved && !(await ctx.attempt(`propose: ${d.proposal.title}`, () => conn.reducers.proposeWorkItem(proposeArgs(d.proposal))))) notes.push('policy draft proposed');
    }
    if (notes.length) return notes.join('; ');
    return kept ? `tier ${final.current} kept (the model declined the rules' change)` : `tier ${final.current} stays`;
  },
};
