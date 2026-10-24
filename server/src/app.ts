import Fastify from 'fastify';
import { connections, downFor } from './lib/stdb';
import { platformRoutes } from './platform/routes';
import type { PlatformSimulator } from './platform/simulator';

export function buildApp(sim: PlatformSimulator) {
  const app = Fastify({ logger: true });
  // The web app (another origin in development) calls the demo endpoints.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-headers', 'content-type, x-demo-key');
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });
  // Unhealthy once any SpacetimeDB connection has been down for 30 s.
  app.get('/health', async (_req, reply) => {
    const down = downFor(30_000);
    return reply.code(down.length ? 503 : 200).send({
      ok: !down.length,
      connections: connections.map((c) => ({ name: c.name, connected: c.conn.isActive, downSince: c.downSince ? new Date(c.downSince).toISOString() : null })),
    });
  });
  // The simulated platform's write APIs. Only the gateway calls them.
  app.register(platformRoutes, { prefix: '/platform', sim });
  return app;
}
