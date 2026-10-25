/**
 * Formula tier on the platform's 1-5 scale (1 best), then the guardrails in order: strategic
 * clients only get a review, upgrades go one step and need a 3-point margin and no recent_late
 * flag, downgrades go at most two steps.
 */
import type { ClientBook, Flag, Scores, TierAction, TierDecision } from './model';

/** (lowest reliability in the band, base tier). Below the last line: tier 5. */
const BANDS: [number, number][] = [[85, 2], [70, 3], [55, 4]];
const LINES = BANDS.map(([line]) => line);
const VALUE_BUMP = 75;
const TIER1_RELIABILITY = 85;
const FLAG_CAP = 3;
export const UPGRADE_MARGIN = 3;
const MAX_DOWNGRADE_STEPS = 2;
const NEAR_LINE = 5;

export const POLICY = { downgrade: 'pol-020', upgrade: 'pol-021', review: 'pol-022' } as const;

/** (base tier, the band's lower line) from reliability alone. */
export function baseBand(reliability: number): [number, number] {
  for (const [line, tier] of BANDS) if (reliability >= line) return [tier, line];
  return [5, 0];
}

const g = (n: number) => String(Number(n.toPrecision(12)));

export function formulaTier(scores: Scores, flags: Flag[]): { tier: number; reasons: string[] } {
  const rel = scores.reliability;
  let [tier, line] = baseBand(rel);
  const reasons = [`reliability ${rel.toFixed(1)} puts the base at tier ${tier} (band from ${g(line)})`];
  if (scores.value >= VALUE_BUMP && tier > 1) {
    const bumped = tier - 1;
    if (bumped === 1 && rel < TIER1_RELIABILITY) {
      reasons.push(`value ${scores.value.toFixed(1)} would lift it, but tier 1 needs reliability ${g(TIER1_RELIABILITY)}`);
    } else {
      tier = bumped;
      reasons.push(`value ${scores.value.toFixed(1)} >= ${g(VALUE_BUMP)} lifts it to tier ${tier}`);
    }
  }
  const fired = flags.filter((f) => f.fired).map((f) => f.pattern);
  if (fired.length && tier < FLAG_CAP) {
    tier = FLAG_CAP;
    reasons.push(`${fired.join(', ')} caps it at tier ${FLAG_CAP}`);
  }
  return { tier, reasons };
}

/** What the fixed rules would do for this client. */
export function decide(book: ClientBook, scores: Scores, flags: Flag[]): TierDecision {
  const current = book.client.tier;
  const { tier: formula, reasons } = formulaTier(scores, flags);
  const near = LINES.some((line) => Math.abs(scores.reliability - line) <= NEAR_LINE);

  const result = (action: TierAction, toTier: number, policyRef: string, why: string): TierDecision => ({
    clientId: book.client.id, current, formula, action, toTier, confidence: near ? 0.7 : 0.9, policyRef, reasons: [...reasons, why],
  });

  if (formula === current) return result('stay', current, '', `formula tier ${formula} matches the current tier`);
  if (book.client.strategic) {
    if (formula > current) return result('review', current, POLICY.review, `strategic: formula says tier ${formula}, so a person reviews the tier`);
    return result('stay', current, '', 'strategic: tiers change only by a person');
  }
  if (formula < current) {
    if (flags.some((f) => f.fired && f.pattern === 'recent_late')) return result('stay', current, '', 'upgrade blocked: recent_late fired');
    const [, line] = baseBand(scores.reliability);
    if (scores.reliability < line + UPGRADE_MARGIN) {
      return result('stay', current, '', `upgrade blocked: reliability ${scores.reliability.toFixed(1)} is within ${g(UPGRADE_MARGIN)} points of the ${g(line)} band line`);
    }
    return result('tier_change', current - 1, POLICY.upgrade, `upgrade one step from tier ${current} to ${current - 1}`);
  }
  const to = current + Math.min(MAX_DOWNGRADE_STEPS, formula - current);
  return result('tier_change', to, POLICY.downgrade, `downgrade from tier ${current} to ${to} (formula ${formula}, at most ${MAX_DOWNGRADE_STEPS} steps)`);
}
