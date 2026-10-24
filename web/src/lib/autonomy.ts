import type { Client, WorkItem } from '../module_bindings/types';

/** Mirrors MIN_AUTO_CONFIDENCE in spacetime/src/autonomy.ts: below it the agent hands off. */
export const MIN_AUTO_CONFIDENCE = 0.1;

const PAYMENT_KINDS = [
  'PAYMENT_MATCH',
  'REFUND',
  'UNIDENTIFIED_CASH',
  'UNAPPLIED_CASH',
  'BOOKS_BREAK',
];

/** Why an open item is waiting for a person, in a few words (the database's rules, read back). */
export function waitingReason(item: WorkItem, client?: Client): string | undefined {
  if (item.autoApplied || (item.state !== 'PROPOSED' && item.state !== 'NEEDS_INFO')) return;
  // Mirrors isTopClient in spacetime/src/autonomy.ts.
  if (client && (client.tier <= 1 || client.strategic)) return 'Top client: a person decides';
  if (item.title.startsWith('Offboarding')) return 'Offboarding: a person decides';
  if (item.policyRef === 'manual')
    return 'Proposed from the console: the other controller approves';
  if (PAYMENT_KINDS.includes(item.kind)) return 'Payment exception: a person checks it';
  if (item.confidence < MIN_AUTO_CONFIDENCE)
    return `Agent only ${Math.round(item.confidence * 100)}% sure: a person decides`;
  return 'Waiting for a person';
}
