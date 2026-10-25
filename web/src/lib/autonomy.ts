import type { Client, WorkItem } from '../module_bindings/types';

/** Mirrors MIN_AUTO_CONFIDENCE in spacetime/src/autonomy.ts: below it the agent hands off. */
export const MIN_AUTO_CONFIDENCE = 0.1;

/** The only reasons the agent asks a person (spacetime/src/autonomy.ts), plus console changes. */
export const REASONS = {
  top: { label: 'Top client', note: 'Restricting a Tier 1 or strategic client' },
  offboarding: { label: 'Offboarding', note: 'Closing a client down' },
  exploit: { label: 'Exploit fix', note: 'Changes the tier guidelines' },
  policy: { label: 'Contract change', note: 'A client policy that changes the contract or moves money' },
  confidence: { label: 'Low confidence', note: 'The agent is under 10% sure' },
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
  return;
}

/** Why an open item is waiting for a person, in a few words. */
export function waitingReason(item: WorkItem, client?: Client): string | undefined {
  if (!isOpen(item)) return;
  const r = reasonFor(item, client);
  return r ? `${REASONS[r].label}: ${REASONS[r].note.toLowerCase()}` : undefined;
}
