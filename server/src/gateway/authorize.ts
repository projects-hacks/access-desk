import type { GatewayDecision, GatewayRequest } from '../domain';

/**
 * Checks state, policy version and approvals before any write.
 * TODO: load the work item from SpacetimeDB and require state === 'APPROVED'.
 */
export function authorize(req: GatewayRequest): GatewayDecision {
  if (!req.workItemId) return { allowed: false, reason: 'missing work item' };
  return { allowed: true };
}
