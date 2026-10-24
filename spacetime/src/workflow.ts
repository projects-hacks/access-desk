/** Lifecycle of every unit of work (a payment match, a restriction, a policy draft). */
export const WORK_ITEM_STATES = ['NEW', 'PROPOSED', 'NEEDS_INFO', 'APPROVED', 'REJECTED', 'POSTED', 'WITHDRAWN'] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

export const TRANSITIONS: Record<WorkItemState, readonly WorkItemState[]> = {
  NEW: ['PROPOSED'],
  PROPOSED: ['NEEDS_INFO', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
  NEEDS_INFO: ['PROPOSED', 'WITHDRAWN'],
  APPROVED: ['POSTED'],
  REJECTED: ['PROPOSED'],
  POSTED: [],
  /** The situation resolved itself (e.g. the payment was found). */
  WITHDRAWN: [],
};

export function canTransition(from: WorkItemState, to: WorkItemState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
