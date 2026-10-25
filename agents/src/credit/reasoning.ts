/**
 * The plain-English paragraph on a proposal the rules decided. When the model decides
 * (decide.ts), its own reasons are the paragraph; this template is the fallback and uses only
 * numbers the engine computed.
 */
import type { Flag, Scores, TierDecision } from './model';

const sentence = (text: string) => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}.`;

export function template(d: TierDecision, scores: Scores, flags: Flag[]): string {
  const b = scores.breakdown as Record<string, number>;
  const head = {
    tier_change: `Proposes tier ${d.current} -> ${d.toTier}.`,
    review: `Asks a controller to review this strategic client's tier ${d.current}.`,
    stay: `Keeps tier ${d.current}.`,
  }[d.action];
  const parts = [
    head,
    `Reliability ${scores.reliability.toFixed(1)} (lateness -${(b.lateness ?? 0).toFixed(1)}, frequency -${(b.frequency ?? 0).toFixed(1)}, severity -${(b.severity ?? 0).toFixed(0)}, ` +
      `paid in pieces -${(b.pieces ?? 0).toFixed(1)}, disputes lost -${(b.disputes ?? 0).toFixed(1)}, over ${(b.periods ?? 0).toFixed(0)} months); value ${scores.value.toFixed(1)}.`,
    sentence(d.reasons.join('; ')),
  ];
  for (const f of flags) {
    if (!f.fired) continue;
    const ids = f.evidence.slice(0, 6).map((e) => e.invoiceId).join(', ');
    const more = f.evidence.length > 6 ? ` and ${f.evidence.length - 6} more` : '';
    parts.push(`${f.pattern}: ${f.measured} (${ids}${more}).`);
  }
  parts.push(`Coverage ${scores.coverageRatio.toFixed(2)}x: ${scores.coverageDetail}`);
  if (scores.expectedSettleOn) parts.push(`Expected to settle by ${scores.expectedSettleOn}.`);
  return parts.join(' ');
}

/** The biggest reasons a client's reliability sits where it does, for the agents panel. */
export function explainReliability(scores: Scores): string {
  const b = scores.breakdown as Record<string, number>;
  const parts: [number, string][] = [
    [b.lateness ?? 0, `paying ${(b.weighted_mean_dpd ?? 0).toFixed(1)} days late on average`],
    [b.frequency ?? 0, `${Math.round((b.late_share ?? 0) * 100)}% of invoices more than 10 days late`],
    [b.severity ?? 0, `worst recent delay ${b.worst_dpd_180d ?? 0} days`],
    [b.pieces ?? 0, 'invoices paid in pieces'],
    [b.disputes ?? 0, `${b.disputes_lost ?? 0} disputes lost`],
  ];
  const top = parts.filter(([penalty]) => penalty > 0).sort((a, c) => c[0] - a[0]).slice(0, 3).map(([, text]) => text);
  return top.length ? `Mostly ${top.join(', ')}.` : 'No late payments held it back.';
}
