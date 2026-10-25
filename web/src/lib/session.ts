import { useMemo } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';

/** Who this browser is connected as, and its role from the `actor` table (none = read-only). */
export function useSession() {
  const conn = useSpacetimeDB();
  const [actors] = useTable(tables.actor);
  const me = conn.identity ? actors.find((a) => a.identity.isEqual(conn.identity!)) : undefined;
  return {
    connected: conn.isActive,
    error: conn.connectionError,
    identity: conn.identity,
    name: me?.name,
    role: me?.role,
    canApprove: me?.role === 'CONTROLLER' || me?.role === 'ACCOUNTANT',
  };
}

export function useClock() {
  const [rows] = useTable(tables.clock);
  return rows[0];
}

export function usePlatform() {
  const [rows] = useTable(tables.platform);
  return rows[0];
}

/** The business hours a platform day covers on screen. */
const OPEN_MIN = 8 * 60;
const HOURS_MIN = 10 * 60;
const two = (n: number) => String(n).padStart(2, '0');

/**
 * When something happened in the platform's own time ("10:42"), not the viewer's clock. A business
 * day runs from its first audit row to the next day's (or for the clock's pace if it is today), and
 * the moment is placed on that day's 08:00–18:00.
 */
export function useSimTime(): (at: { microsSinceUnixEpoch: bigint }, simDate: string) => string {
  const [audit] = useTable(tables.auditEvent);
  const clock = useClock();
  return useMemo(() => {
    const ms = (ts: { microsSinceUnixEpoch: bigint }) => Number(ts.microsSinceUnixEpoch / 1000n);
    const start = new Map<string, number>();
    for (const e of audit) {
      const t = ms(e.at);
      const s = start.get(e.simDate);
      if (s === undefined || t < s) start.set(e.simDate, t);
    }
    const days = [...start.keys()].sort();
    const next = new Map(days.map((d, i) => [d, days[i + 1]]));
    const pace = (clock?.secondsPerDay || 240) * 1000;
    return (at, simDate) => {
      const s = start.get(simDate);
      if (s === undefined) return '';
      const n = next.get(simDate);
      const length = n ? start.get(n)! - s : pace;
      const frac = Math.min(0.999, Math.max(0, (ms(at) - s) / length));
      const minutes = OPEN_MIN + Math.floor(frac * HOURS_MIN);
      return `${two(Math.floor(minutes / 60))}:${two(minutes % 60)}`;
    };
  }, [audit, clock?.secondsPerDay]);
}
