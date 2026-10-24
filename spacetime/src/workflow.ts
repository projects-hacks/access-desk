/** Lifecycle of every unit of work (a payment match, a restriction, a policy draft). */
export const WORK_ITEM_STATES = ['NEW', 'PROPOSED', 'NEEDS_INFO', 'APPROVED', 'REJECTED', 'POSTED'] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

export const TRANSITIONS: Record<WorkItemState, readonly WorkItemState[]> = {
  NEW: ['PROPOSED'],
  PROPOSED: ['NEEDS_INFO', 'APPROVED', 'REJECTED'],
  NEEDS_INFO: ['PROPOSED'],
  APPROVED: ['POSTED'],
  REJECTED: ['PROPOSED'],
  POSTED: [],
};

export function canTransition(from: WorkItemState, to: WorkItemState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
