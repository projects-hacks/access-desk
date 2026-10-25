import type { DbConnection } from '../module_bindings';
import type { PlatformSimulator } from '../platform/simulator';

/** Assets priced from the market; USD stays at 100 cents. */
const LIVE = ['BTC', 'ETH'];
const EVERY_MS = 30_000;

/** Coinbase's public spot price in cents (no key), or undefined when it can't be read. */
export async function spotCents(asset: string): Promise<number | undefined> {
  try {
    const res = await fetch(`https://api.coinbase.com/v2/prices/${asset}-USD/spot`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return undefined;
    const amount = Number(((await res.json()) as { data?: { amount?: string } }).data?.amount);
    return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prices custody at the live market: the platform revalues its holdings, then the golden copy
 * gets the new price and every holding that changed. If the feed is down the last price stays.
 */
export function startPriceFeed(conn: DbConnection, sim: PlatformSimulator, log: (msg: string) => void): () => void {
  let warned = false;
  const tick = async () => {
    for (const asset of LIVE) {
      const cents = await spotCents(asset);
      if (cents === undefined) {
        if (!warned) log(`[prices] ${asset} spot price unavailable; keeping the last price`);
        warned = true;
        continue;
      }
      if (sim.prices.get(asset)?.cents === cents) continue;
      const asOf = new Date().toISOString();
      const changed = sim.setPrice(asset, cents, asOf);
      try {
        await conn.reducers.upsertAssetPrice({ row: { asset, priceCents: BigInt(cents), asOf } });
        await Promise.all(changed.map((h) => conn.reducers.upsertCustodyHolding({ row: { ...h, valueCents: BigInt(h.valueCents) } })));
      } catch (e) {
        log(`[prices] could not write ${asset}: ${e instanceof Error ? e.message : e}`);
      }
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), EVERY_MS);
  return () => clearInterval(timer);
}
