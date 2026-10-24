/** Separation of duties: proposers never approve their own work; only the gateway posts. */
export const ROLES = [
  'ADMIN', 'SYNC', 'GATEWAY', 'AGENT', 'ACCOUNTANT', 'RELATIONSHIP_MANAGER', 'CONTROLLER', 'CLIENT', 'VIEWER',
] as const;
export type Role = (typeof ROLES)[number];

export const CAN_APPROVE: readonly Role[] = ['ACCOUNTANT', 'CONTROLLER'];
export const CAN_POST: readonly Role[] = ['GATEWAY'];
export const CAN_SYNC: readonly Role[] = ['SYNC', 'ADMIN'];
export const CAN_MOVE_CLOCK: readonly Role[] = ['CONTROLLER', 'ADMIN'];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
