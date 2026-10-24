import { useEffect, useMemo, useRef, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import type { AuditEvent, CashMovement, PaymentApplication, TieOutRun } from '../module_bindings/types';
import { parseJson } from './format';

/** Live bank movements (the Nessie window), newest first. History stays out of the subscription. */
export function useBankFeed(): [CashMovement[], boolean] {
  const [rows, ready] = useTable(tables.cashMovement.where((r) => r.isHistory.eq(false)));
  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.valueOn.localeCompare(a.valueOn) || b.bankRef.localeCompare(a.bankRef)),
    [rows],
  );
  return [sorted, ready];
}

/** Who an account or wallet belongs to, from the CRM (wallet transfers carry no payer name). */
export function usePayerNames(): Map<string, string> {
  const [ids] = useTable(tables.payerIdentity);
  return useMemo(() => new Map(ids.filter((p) => p.kind === 'bank_account' || p.kind === 'wallet').map((p) => [p.value, p.label])), [ids]);
}

/** Applications by movement, so each wire shows the invoices it paid. */
export function useApplications(): Map<string, PaymentApplication[]> {
  const [apps] = useTable(tables.paymentApplication);
  return useMemo(() => {
    const by = new Map<string, PaymentApplication[]>();
    for (const a of apps) {
      if (a.reversed) continue;
      by.set(a.movementId, [...(by.get(a.movementId) ?? []), a]);
    }
    return by;
  }, [apps]);
}

export type TieArea = { area: string; operations: bigint; ledger: bigint };

/** The latest tie-out run and its areas (bank vs GL per account, receivables, unapplied). */
export function useLatestTieOut(): { run?: TieOutRun; areas: TieArea[] } {
  const [runs] = useTable(tables.tieOutRun);
  return useMemo(() => {
    const run = runs.reduce<TieOutRun | undefined>((best, r) => (!best || r.id > best.id ? r : best), undefined);
    const summary = parseJson<Record<string, { operations: string; ledger: string }>>(run?.summaryJson ?? '{}', {});
    const areas = Object.entries(summary).map(([area, v]) => ({
      area,
      operations: BigInt(v.operations || '0'),
      ledger: BigInt(v.ledger || '0'),
    }));
    return { run, areas };
  }, [runs]);
}

/** Row ids that arrived after the first load, for a brief highlight. */
export function useArrivals(ids: string[], ready: boolean, holdMs = 6000): Set<string> {
  const seen = useRef<Set<string> | undefined>(undefined);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!ready) return;
    if (!seen.current) {
      seen.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !seen.current!.has(id));
    if (!added.length) return;
    added.forEach((id) => seen.current!.add(id));
    setFresh((s) => new Set([...s, ...added]));
    const t = setTimeout(() => setFresh((s) => new Set([...s].filter((id) => !added.includes(id)))), holdMs);
    return () => clearTimeout(t);
  }, [ids, ready, holdMs]);
  return fresh;
}

/** Re-renders every second, for "synced 3s ago" labels. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

const MATCH: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  matched: { label: 'Matched', tone: 'good' },
  unmatched: { label: 'Reading', tone: 'info' },
  exception: { label: 'Needs a person', tone: 'warn' },
  proposed: { label: 'To confirm', tone: 'warn' },
  in_transit: { label: 'In transit', tone: 'info' },
  refunded: { label: 'Refunded', tone: 'neutral' },
  reversed: { label: 'Returned', tone: 'bad' },
};

/** What payment checking concluded about a movement. */
export function matchBadge(m: CashMovement) {
  if (m.status === 'pending') return { label: 'In transit', tone: 'info' as const };
  return MATCH[m.matchStatus] ?? { label: m.matchStatus, tone: 'neutral' as const };
}

/** Wire, ACH, fee... in the words a treasury analyst uses. */
export function rail(m: CashMovement): string {
  if (m.category === 'fee') return 'Bank fee';
  if (m.category === 'ach_return') return `ACH return${m.returnCode ? ` ${m.returnCode}` : ''}`;
  if (m.network === 'SWIFT') return 'SWIFT';
  if (m.network === 'FEDWIRE') return 'Fedwire';
  if (m.network === 'ACH') return 'ACH';
  return m.rail === 'BOOK' ? 'Book transfer' : m.network || m.rail;
}

/** The Nessie record id behind a movement ('nessie:<uuid>'). */
export const nessieId = (m: CashMovement) => (m.source === 'nessie' ? m.id.replace(/^nessie:/, '') : undefined);

/** Audit actions that are plumbing rather than decisions or money. */
const QUIET = new Set(['TIE_OUT', 'COMMAND_QUEUED', 'COMMAND_DONE', 'CASH_RECONCILED', 'SET_PLATFORM', 'ASSIGN_ROLE', 'POLICY_SAVED']);
export const isNews = (e: AuditEvent) => !QUIET.has(e.action);

/** Who did it, as people say it. */
export function actor(e: AuditEvent): string {
  switch (e.actorRole) {
    case 'AGENT': return 'Agent';
    case 'SYNC': return 'Sync';
    case 'GATEWAY': return 'Gateway';
    case 'SYSTEM': return 'Scheduler';
    case 'DEMO': return 'Demo';
    default: return e.actorName || e.actorRole.toLowerCase();
  }
}
