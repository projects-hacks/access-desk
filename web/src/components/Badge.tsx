import type { ReactNode } from 'react';
import { label } from '../lib/format';

export type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'bad';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

const STATE_TONE: Record<string, Tone> = {
  NEW: 'neutral',
  PROPOSED: 'warn',
  NEEDS_INFO: 'info',
  APPROVED: 'info',
  POSTED: 'good',
  REJECTED: 'bad',
  WITHDRAWN: 'neutral',
};

/** A work item's state as a coloured pill. */
export function StateBadge({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state] ?? 'neutral'}>{label(state)}</Badge>;
}
