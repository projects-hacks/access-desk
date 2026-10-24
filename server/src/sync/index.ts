import type { SyncSource } from './source';

const INTERVAL_MS = 10_000;

/**
 * Pulls each source on an interval: raw -> standardized -> golden.
 * TODO: persist cursors and golden rows through SpacetimeDB reducers
 * (advanceSyncCursor, recordBankTransaction).
 */
export function startSync(sources: SyncSource[], log: (msg: string) => void) {
  const cursors = new Map<string, string | undefined>();

  const tick = async () => {
    for (const source of sources) {
      try {
        const { rows, cursor } = await source.fetchChanges(cursors.get(source.name));
        if (rows.length) log(`[sync:${source.name}] ${rows.length} changed rows`);
        cursors.set(source.name, cursor);
      } catch (err) {
        log(`[sync:${source.name}] ${String(err)}`);
      }
    }
  };

  const timer = setInterval(tick, INTERVAL_MS);
  return () => clearInterval(timer);
}
