import type { FastifyInstance } from 'fastify';
import { store } from './store';

/**
 * Read side of the simulated systems of record (billing, ledger, admin console).
 * Writes happen only through the gateway.
 */
export async function simulatorRoutes(app: FastifyInstance) {
  /** Change feed: invoices updated after `since` (ISO timestamp). */
  app.get<{ Querystring: { since?: string } }>('/billing/invoices', async (req) => {
    const since = req.query.since ?? '';
    const items = [...store.invoices.values()].filter((i) => i.updatedAt > since);
    const cursor = items.reduce((max, i) => (i.updatedAt > max ? i.updatedAt : max), since);
    return { items, cursor };
  });

  app.get('/ledger', async () => store.ledger);
  app.get('/admin/restrictions', async () => [...store.restrictions.values()]);
}
