/** Separation of duties: proposers never approve their own work; only the gateway posts. */
export const ROLES = ['AGENT', 'ACCOUNTANT', 'RELATIONSHIP_MANAGER', 'CONTROLLER', 'GATEWAY', 'SYNC', 'CLIENT'] as const;
export type Role = (typeof ROLES)[number];

export const CAN_APPROVE: readonly Role[] = ['ACCOUNTANT', 'CONTROLLER'];
export const CAN_POST: readonly Role[] = ['GATEWAY'];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
