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
