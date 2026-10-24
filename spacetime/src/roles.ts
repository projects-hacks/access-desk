/** Separation of duties: proposers never approve their own work; only the gateway posts. */
export const ROLES = [
  'ADMIN', 'SYNC', 'GATEWAY', 'DEMO', 'AGENT', 'ACCOUNTANT', 'RELATIONSHIP_MANAGER', 'CONTROLLER', 'CLIENT', 'VIEWER',
] as const;
export type Role = (typeof ROLES)[number];

export const CAN_APPROVE: readonly Role[] = ['ACCOUNTANT', 'CONTROLLER'];
export const CAN_POST: readonly Role[] = ['GATEWAY'];
export const CAN_EXECUTE: readonly Role[] = ['GATEWAY'];
export const CAN_SYNC: readonly Role[] = ['SYNC', 'ADMIN'];
export const CAN_MOVE_CLOCK: readonly Role[] = ['CONTROLLER', 'ADMIN', 'DEMO'];
/** Demo controls (the server's demo identity) and the owner can reset the shared world. */
export const CAN_RESET: readonly Role[] = ['ADMIN', 'DEMO'];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
