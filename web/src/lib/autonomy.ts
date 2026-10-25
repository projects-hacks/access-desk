import type { Client, WorkItem } from '../module_bindings/types';
import { parseJson } from './format';

/** Mirrors MIN_AUTO_CONFIDENCE in spacetime/src/autonomy.ts: below it the agent hands off. */
export const MIN_AUTO_CONFIDENCE = 0.1;
/** Mirrors MIN_OVERRIDE_CONFIDENCE: a model's tier move that differs from the rules needs this much. */
export const MIN_OVERRIDE_CONFIDENCE = 0.7;

/** The only reasons the agent asks a person (spacetime/src/autonomy.ts), plus console changes. */
export const REASONS = {
  top: { label: 'Top client', note: 'Restricting a Tier 1 or strategic client' },
  offboarding: { label: 'Offboarding', note: 'Closing a client down' },
  exploit: { label: 'Exploit fix', note: 'Changes the tier guidelines' },
  policy: { label: 'Contract change', note: 'A client policy that changes the contract or moves money' },
  confidence: { label: 'Low confidence', note: 'The agent is under 10% sure' },
  promotion: { label: 'Tier 1 promotion', note: 'Moves a client into Tier 1' },
  judgment: { label: 'Model judgment', note: 'Goes beyond the rules at under 70% confidence' },
  console: { label: 'Console change', note: 'Made by the controller' },
} as const;

export type ReasonKey = keyof typeof REASONS;

const isOpen = (w: WorkItem) => w.state === 'PROPOSED' || w.state === 'NEEDS_INFO';

/** Which of the reasons put this item in front of a person (for open or decided items). */
export function reasonFor(item: WorkItem, client?: Client): ReasonKey | undefined {
  if (item.autoApplied) return;
  if (item.kind === 'POLICY_DRAFT') return item.policyRef.startsWith('exploit-fix-') ? 'exploit' : 'policy';
  if (item.title.startsWith('Offboarding')) return 'offboarding';
  if (item.policyRef === 'manual') return 'console';
  // Mirrors isTopClient in spacetime/src/autonomy.ts.
  if (client && (client.tier <= 1 || client.strategic)) return 'top';
  if (item.confidence < MIN_AUTO_CONFIDENCE) return 'confidence';
  // Mirrors the tier rules in needsHuman (spacetime/src/autonomy.ts).
  if (item.kind === 'CREDIT_REVIEW') {
    const p = parseJson<{ action?: string; to_tier?: number; decided_by?: string; baseline?: { action?: string; to_tier?: number } }>(item.proposalJson, {});
    if (p.action === 'tier_change' && Number(p.to_tier) === 1) return 'promotion';
    const base = p.baseline;
    const beyond = p.decided_by && p.decided_by !== 'rules' && base
      && (base.action !== p.action || (p.action === 'tier_change' && Number(base.to_tier) !== Number(p.to_tier)));
    if (beyond && item.confidence < MIN_OVERRIDE_CONFIDENCE) return 'judgment';
  }
  return;
}

/** Why an open item is waiting for a person, in a few words. */
export function waitingReason(item: WorkItem, client?: Client): string | undefined {
  if (!isOpen(item)) return;
  const r = reasonFor(item, client);
  return r ? `${REASONS[r].label}: ${REASONS[r].note.toLowerCase()}` : undefined;
}
