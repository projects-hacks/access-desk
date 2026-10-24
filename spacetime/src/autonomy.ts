/**
 * Which agent proposals a controller must decide, and which apply on their own.
 *
 * Tier 1 and 2 clients are the big accounts: everything about them goes to a
 * controller. For tier 3 to 5, what the credit agents propose applies at once
 * (after the guardrails), except the worst cases below, which still need a person.
 * Pure, so it is unit-tested; the module calls it from propose_work_item.
 */

/** Clients at or above this tier (1 and 2) always get a controller. */
export const MANUAL_TIER_MAX = 2;
/** A move onto this tier restricts access hardest. */
export const WORST_TIER = 5;
/** Below this the agent is not sure enough to act alone. */
export const MIN_AUTO_CONFIDENCE = 0.6;
/** Policy terms that move money or change the contract. */
export const HUMAN_TERMS = ['custody_debit', 'cross_default'] as const;
/** Kinds this rule governs; every other kind keeps its own approval path. */
export const GOVERNED_KINDS = ['CREDIT_REVIEW', 'POLICY_DRAFT', 'EXPLOIT_FLAG'] as const;

export interface AutonomyInput {
  kind: string;
  /** The client's tier now, read from the database (not from the proposal). */
  tier: number;
  strategic: boolean;
  confidence: number;
  proposal: unknown;
}

export const isGoverned = (kind: string) => (GOVERNED_KINDS as readonly string[]).includes(kind);

/** Why a person must decide this, or undefined when it can apply on its own. */
export function needsHuman(i: AutonomyInput): string | undefined {
  if (i.strategic) return 'strategic client';
  if (i.tier <= MANUAL_TIER_MAX) return `tier ${i.tier} client`;
  const p = (i.proposal ?? {}) as { action?: string; to_tier?: number; rule?: { terms?: { lever?: string }[] } };
  if (i.kind === 'CREDIT_REVIEW') {
    if (p.action === 'review') return 'a review was requested';
    if (p.action === 'tier_change') {
      const to = Number(p.to_tier);
      if (!Number.isInteger(to) || to < 1 || to > 5) return 'unreadable tier';
      if (to <= MANUAL_TIER_MAX) return `moves the client to tier ${to}`;
      if (to === WORST_TIER) return `moves the client to tier ${WORST_TIER}, the strictest`;
    }
  }
  if (i.kind === 'POLICY_DRAFT') {
    const bad = (p.rule?.terms ?? []).find((t) => (HUMAN_TERMS as readonly string[]).includes(String(t.lever)));
    if (bad) return `${String(bad.lever).replace(/_/g, ' ')} moves money or changes the contract`;
  }
  if (i.kind !== 'EXPLOIT_FLAG' && i.confidence < MIN_AUTO_CONFIDENCE) {
    return `confidence ${i.confidence.toFixed(2)} is below ${MIN_AUTO_CONFIDENCE}`;
  }
  return undefined;
}
