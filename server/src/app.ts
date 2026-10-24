import Fastify from 'fastify';
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
  app.get('/health', async () => ({ ok: true }));
  // The simulated platform's write APIs. Only the gateway calls them.
  app.register(platformRoutes, { prefix: '/platform', sim });
  return app;
}
