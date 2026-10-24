import type { FastifyInstance } from 'fastify';
import { GatewayRequestSchema } from '../domain';
import { authorize } from './authorize';
import { execute } from './execute';

/** The only writer to systems of record. */
export async function gatewayRoutes(app: FastifyInstance) {
  app.post('/gateway/actions', async (req, reply) => {
    const parsed = GatewayRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });

    const decision = authorize(parsed.data);
    // TODO: record the decision (allowed or denied) as an audit event in SpacetimeDB.
    if (!decision.allowed) return reply.code(403).send(decision);

    await execute(parsed.data.action);
    return decision;
  });
}
