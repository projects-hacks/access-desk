import type { FastifyInstance } from 'fastify';
import type { World } from './engine';

/** Read-only view of the world engine: pace, clock, what it did last, who behaves how. */
export function worldRoutes(app: FastifyInstance, world: () => World | undefined) {
  app.get('/world/state', async () => world()?.state() ?? { enabled: false });
}
