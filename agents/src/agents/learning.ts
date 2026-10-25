import { clientOf, evaluate, outcomeText, parsePolicies } from '../credit/company';
import { loadBilling, loadBook } from '../credit/load';
import { explainReliability } from '../credit/reasoning';
import { scoreBook, wholeScore } from '../credit/scoring';
import { BOOKS, handleBooks } from '../books/handle';
import type { Agent } from '../types';

/** Reliability moving at least this much is worth a line on the panel. */
const NOTABLE_MOVE = 5;

/** The verdict text without its date, so an unchanged verdict is not written again each day. */
const undated = (outcome: string) => outcome.replace(/ on \d{4}-\d{2}-\d{2}:/, ':');

/**
 * Keeps one client's credit profile current: reliability, value, coverage and the expected
 * settle date, from the books alone. The database wakes the scoring agent when a score moves.
 * Also records how each of the client's active company policies is doing.
 */
export const learning: Agent = {
  name: 'learning',
  concurrency: 4,
  async handle(ctx) {
    const { conn, today } = ctx;
    const clientId = ctx.task.clientId;
    if (clientId === BOOKS) return handleBooks(ctx);
    const book = loadBook(conn, clientId, today);
    if (!book) return 'unknown client';
    const scores = scoreBook(book, loadBilling(conn, today));

    const profile = {
      clientId,
      valueScore: wholeScore(scores.value),
      reliabilityScore: wholeScore(scores.reliability),
      coverageRatio: Math.round(scores.coverageRatio * 10_000) / 10_000,
      coverageDetail: scores.coverageDetail,
      expectedSettleOn: scores.expectedSettleOn ?? undefined,
    };
    const before = conn.db.creditProfile.clientId.find(clientId);
    const same = before && before.valueScore === profile.valueScore && before.reliabilityScore === profile.reliabilityScore && before.coverageRatio === profile.coverageRatio
      && before.coverageDetail === profile.coverageDetail && before.expectedSettleOn === profile.expectedSettleOn;
    let summary = 'profile unchanged';
    if (!same) {
      const refused = await ctx.attempt(`update ${book.client.name}'s credit profile`, () => conn.reducers.upsertCreditProfile(profile));
      if (refused) return `profile not saved: ${refused}`;
      const moved = before && (before.reliabilityScore !== profile.reliabilityScore || before.valueScore !== profile.valueScore);
      summary = !before ? `first profile: reliability ${profile.reliabilityScore} · value ${profile.valueScore}`
        : moved ? `reliability ${before.reliabilityScore} → ${profile.reliabilityScore} · value ${before.valueScore} → ${profile.valueScore}` : 'profile refreshed';
      if (before && Math.abs(profile.reliabilityScore - before.reliabilityScore) >= NOTABLE_MOVE) {
        const dir = profile.reliabilityScore > before.reliabilityScore ? 'rose' : 'fell';
        await ctx.say(`${book.client.name}'s reliability ${dir} from ${before.reliabilityScore} to ${profile.reliabilityScore}.`, explainReliability(scores));
      }
    }

    // How the client's own policies are doing (the verdict lands on the precedent of the approval that activated them).
    const rows = [...conn.db.policy.iter()].filter((p) => clientOf(p.policyId) === clientId);
    let recorded = 0;
    for (const policy of parsePolicies(rows).filter((p) => p.status === 'active')) {
      const verdict = evaluate(book, policy);
      const precedent = policy.workItemId ? conn.db.precedent.id.find(`PRC-L${policy.workItemId}`) : undefined;
      if (verdict.status === 'pending' || !precedent) continue;
      const outcome = outcomeText(verdict, today);
      if (undated(precedent.outcome) === undated(outcome)) continue;
      if (!(await ctx.attempt(`record that ${policy.title} is ${verdict.status}`, () => conn.reducers.recordPolicyOutcome({ policyKey: policy.key, outcome })))) recorded++;
    }
    return recorded ? `${summary}; ${recorded} policy verdict${recorded > 1 ? 's' : ''} recorded` : summary;
  },
};
