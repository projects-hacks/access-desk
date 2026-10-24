/**
 * Which agent proposals a controller must decide, and which apply on their own.
 *
 * The desk acts on its own. A person decides only for the top clients (Tier 1 or
 * strategic), for offboarding, which is decided where the step is chosen
 * (capability.two_approvers, permissions.ts), and when the agent's own confidence is
 * below MIN_AUTO_CONFIDENCE. Company policy drafts also wait when a term moves money
 * or changes the contract.
 * Pure, so it is unit-tested; the module calls it from propose_work_item.
 */

/** Below this the agent is not sure enough to act alone; every agent proposal checks it. */
export const MIN_AUTO_CONFIDENCE = 0.1;

/** The top clients (the top 0.1%): Tier 1, or marked strategic by a person. */
export function isTopClient(tier: number, strategic: boolean): boolean {
  return tier <= 1 || strategic;
}

export function lowConfidence(confidence: number): string | undefined {
  return confidence < MIN_AUTO_CONFIDENCE ? `confidence ${confidence.toFixed(2)} is below ${MIN_AUTO_CONFIDENCE}` : undefined;
}
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
  if (isTopClient(i.tier, i.strategic)) return i.strategic ? 'strategic client' : 'tier 1 client';
  const p = (i.proposal ?? {}) as { action?: string; to_tier?: number; rule?: { terms?: { lever?: string }[] } };
  if (i.kind === 'CREDIT_REVIEW' && p.action === 'tier_change') {
    const to = Number(p.to_tier);
    if (!Number.isInteger(to) || to < 1 || to > 5) return 'unreadable tier';
  }
  if (i.kind === 'POLICY_DRAFT') {
    const bad = (p.rule?.terms ?? []).find((t) => (HUMAN_TERMS as readonly string[]).includes(String(t.lever)));
    if (bad) return `${String(bad.lever).replace(/_/g, ' ')} moves money or changes the contract`;
  }
  // Exploit alerts are warnings to read, not actions: they never wait on confidence.
  return i.kind === 'EXPLOIT_FLAG' ? undefined : lowConfidence(i.confidence);
}
