import type { SyncSource } from '../source';

export class BillingSource implements SyncSource {
  readonly name = 'billing';
  constructor(private readonly baseUrl: string) {}

  async fetchChanges(cursor: string | undefined) {
    const url = new URL('/billing/invoices', this.baseUrl);
    if (cursor) url.searchParams.set('since', cursor);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`billing ${res.status}`);
    const body = (await res.json()) as { items: unknown[]; cursor: string };
    return { rows: body.items, cursor: body.cursor || cursor };
  }
}
