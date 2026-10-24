import Fastify from 'fastify';
import { platformRoutes } from './platform/routes';
import type { PlatformSimulator } from './platform/simulator';

export function buildApp(sim: PlatformSimulator) {
  const app = Fastify({ logger: true });
  app.get('/health', async () => ({ ok: true }));
  // The simulated platform's write APIs. Only the gateway calls them.
  app.register(platformRoutes, { prefix: '/platform', sim });
  return app;
}
