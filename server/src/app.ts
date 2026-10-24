import Fastify from 'fastify';
import { gatewayRoutes } from './gateway/routes';
import { simulatorRoutes } from './simulator/routes';

export function buildApp() {
  const app = Fastify({ logger: true });
  app.get('/health', async () => ({ ok: true }));
  app.register(simulatorRoutes, { prefix: '/sim' });
  app.register(gatewayRoutes);
  return app;
}
