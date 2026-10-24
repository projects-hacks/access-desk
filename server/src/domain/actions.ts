import { z } from 'zod';
import { PRODUCTS } from './products';

/** Every write to a system of record is one of these, and only the gateway executes them. */
export const GatewayActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('POST_LEDGER_ENTRY'),
    debitAccount: z.string(),
    creditAccount: z.string(),
    amountCents: z.number().int(),
    memo: z.string(),
  }),
  z.object({
    type: z.literal('SEND_MESSAGE'),
    clientId: z.string(),
    channel: z.enum(['EMAIL', 'PORTAL']),
    body: z.string(),
  }),
  z.object({
    type: z.literal('SET_RESTRICTION'),
    clientId: z.string(),
    product: z.enum(PRODUCTS),
    step: z.string(),
  }),
  z.object({ type: z.literal('LIFT_RESTRICTION'), clientId: z.string(), product: z.enum(PRODUCTS) }),
  z.object({ type: z.literal('SET_PREPAY'), clientId: z.string(), enabled: z.boolean() }),
]);
export type GatewayAction = z.infer<typeof GatewayActionSchema>;

export const GatewayRequestSchema = z.object({
  workItemId: z.string(),
  policyVersion: z.string().min(1),
  action: GatewayActionSchema,
});
export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;

export type GatewayDecision = { allowed: true } | { allowed: false; reason: string };
