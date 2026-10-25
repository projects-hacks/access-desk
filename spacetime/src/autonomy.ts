/**
 * Which agent proposals a controller must decide, and which apply on their own.
 *
 * The desk acts on its own. A person decides only:
 * - to restrict a top client (Tier 1 or strategic);
 * - to offboard a client, decided where the step is chosen (capability.two_approvers,
 *   permissions.ts);
 * - on a client policy that changes the contract or moves money (prepay, cure or grace days,
 *   cross-default, custody debit). One that only adds reminders is within the desk's authority
 *   (pol-007) and applies on its own;
 * - as a safety net, when the agent's own confidence is below MIN_AUTO_CONFIDENCE.
 * Pure, so it is unit-tested; the module calls it from propose_work_item.
 */

/** Below this the agent is not sure enough to act alone; every agent proposal checks it. */
export const MIN_AUTO_CONFIDENCE = 0.1;
/** A model's tier move that differs from what the rules would do applies on its own only this sure. */
export const MIN_OVERRIDE_CONFIDENCE = 0.7;

/** The top clients (the top 0.1%): Tier 1, or marked strategic by a person. */
export function isTopClient(tier: number, strategic: boolean): boolean {
  return tier <= 1 || strategic;
}

export function lowConfidence(confidence: number): string | undefined {
  return confidence < MIN_AUTO_CONFIDENCE ? `confidence ${confidence.toFixed(2)} is below ${MIN_AUTO_CONFIDENCE}` : undefined;
}
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
  if (i.kind === 'POLICY_DRAFT') {
    const terms = ((i.proposal ?? {}) as { rule?: { terms?: { lever?: string }[] } }).rule?.terms ?? [];
    // Reminders are already the desk's to send; anything else changes what the client signed.
    return terms.length && terms.every((t) => t.lever === 'reminder') ? undefined : 'changes the contract or moves money';
  }
  // Exploit alerts are warnings to read, not actions.
  if (i.kind === 'EXPLOIT_FLAG') return undefined;
  if (isTopClient(i.tier, i.strategic)) return i.strategic ? 'strategic client' : 'tier 1 client';
  const p = (i.proposal ?? {}) as { action?: string; to_tier?: number; decided_by?: string; baseline?: { action?: string; to_tier?: number } };
  if (i.kind === 'CREDIT_REVIEW' && p.action === 'tier_change') {
    const to = Number(p.to_tier);
    if (!Number.isInteger(to) || to < 1 || to > 5) return 'unreadable tier';
    // Tier 1 clients are a person's to handle, so a person decides who joins them.
    if (to === 1) return 'promotion to tier 1';
  }
  // The model may go further than the rules, but only when it is sure; otherwise a person decides.
  const base = p.baseline;
  const beyondRules = i.kind === 'CREDIT_REVIEW' && p.decided_by && p.decided_by !== 'rules' && base
    && (base.action !== p.action || (p.action === 'tier_change' && Number(base.to_tier) !== Number(p.to_tier)));
  if (beyondRules && i.confidence < MIN_OVERRIDE_CONFIDENCE) {
    return `the model went beyond the rules at confidence ${i.confidence.toFixed(2)}, below ${MIN_OVERRIDE_CONFIDENCE}`;
  }
  return lowConfidence(i.confidence);
}
