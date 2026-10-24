import type { FastifyInstance } from 'fastify';
import { GatewayActionSchema, type ActionType } from './commands';
import { PlatformError, type PlatformSimulator } from './simulator';

/** Which platform API each command type calls, as a real platform would expose them. */
export const ROUTES: Record<Exclude<ActionType, 'REFUND'>, string> = {
  APPLY_PAYMENT: '/billing/applications',
  REVERSE_PAYMENT: '/billing/reversals',
  POST_JOURNAL: '/gl/journals',
  PLACE_HOLD: '/admin/holds',
  RELEASE_HOLD: '/admin/holds/release',
  SET_LEVER: '/admin/levers',
  CUSTODY_DEBIT: '/custody/debits',
  CUSTODY_WITHDRAWAL: '/custody/withdrawals',
  SEND_NOTICE: '/notices',
};

/**
 * The simulated platform's write APIs. Every request carries the gateway's
 * command id, which makes it idempotent. 422 = the platform refused (permanent).
 */
export async function platformRoutes(app: FastifyInstance, opts: { sim: PlatformSimulator }) {
  for (const [type, path] of Object.entries(ROUTES)) {
    app.post<{ Body: { commandId: string; action: unknown } }>(path, async (req, reply) => {
      const parsed = GatewayActionSchema.safeParse(req.body?.action);
      if (!parsed.success || parsed.data.type !== type) {
        return reply.code(400).send({ error: parsed.success ? `expected ${type}` : parsed.error.issues });
      }
      try {
        return opts.sim.apply(req.body.commandId, parsed.data);
      } catch (err) {
        if (err instanceof PlatformError) return reply.code(422).send({ error: err.message });
        throw err;
      }
    });
  }
}
