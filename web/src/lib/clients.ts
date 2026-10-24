import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import type { Client, Contract, Invoice, WorkItem } from '../module_bindings/types';
import { useClock } from './session';

export const LEVERS = [
  { key: 'withdrawals', name: 'Withdraw' },
  { key: 'trading', name: 'Trade' },
  { key: 'api', name: 'API' },
  { key: 'financing', name: 'Borrow' },
] as const;

export type Lever = { key: string; name: string; state: string; detail: string };

export type ClientRow = {
  client: Client;
  contract?: Contract;
  unpaidCents: bigint;
  overdueCents: bigint;
  disputedCents: bigint;
  /** Days since the oldest undisputed overdue invoice fell due (0 = nothing overdue). */
  daysPastDue: number;
  /** Past due and past the contract's grace period. */
  inDefault: boolean;
  expected?: { on: string; source: 'promised' | 'predicted' } | { prepay: true };
  status: { label: string; tone: 'neutral' | 'info' | 'good' | 'warn' | 'bad' };
  levers: Lever[];
  waiting: WorkItem[];
  next: string;
  flagged: boolean;
  invoices: Invoice[];
};

const OPEN = ['PROPOSED', 'NEEDS_INFO'];

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function shortDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** One row per client, derived live from invoices, deadlines, levers and open work. */
export function useClientRows(): ClientRow[] {
  const today = useClock()?.simDate ?? '';
  const [clients] = useTable(tables.client);
  const [contracts] = useTable(tables.contract);
  const [invoices] = useTable(tables.invoice);
  const [levers] = useTable(tables.accessLever);
  const [deadlines] = useTable(tables.deadline);
  const [items] = useTable(tables.workItem);
  const [profiles] = useTable(tables.creditProfile);
  const [flags] = useTable(tables.exploitFlag);

  return useMemo(() => {
    const by = <T extends { clientId: string }>(rows: readonly T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) (m.get(r.clientId) ?? m.set(r.clientId, []).get(r.clientId)!).push(r);
      return m;
    };
    const invoicesBy = by(invoices);
    const leversBy = by(levers);
    const deadlinesBy = by(deadlines);
    const itemsBy = by(items);

    return clients.map((client) => {
      const contract = contracts.find((c) => c.clientId === client.id);
      const own = invoicesBy.get(client.id) ?? [];
      const owed = (i: Invoice) => i.amountCents - i.paidCents;
      const unpaid = own.filter((i) => i.status !== 'void' && owed(i) > 0n);
      const overdue = unpaid.filter((i) => i.dueOn < today && i.status !== 'disputed');
      const sum = (xs: Invoice[]) => xs.reduce((s, i) => s + owed(i), 0n);
      const oldest = overdue.map((i) => i.dueOn).sort()[0];
      const daysPastDue = oldest && today ? daysBetween(oldest, today) : 0;
      const inDefault = daysPastDue > (contract?.graceDays ?? 0);

      const ds = deadlinesBy.get(client.id) ?? [];
      const promise = ds.find((d) => d.kind === 'promise_to_pay' && d.status === 'open');
      const cure = ds.find((d) => d.kind === 'cure_period' && d.status === 'open');
      const cureOver = ds.some((d) => d.kind === 'cure_period' && d.status === 'expired');
      const predicted = profiles.find((p) => p.clientId === client.id)?.expectedSettleOn;
      const expected: ClientRow['expected'] =
        client.status === 'prepay'
          ? { prepay: true }
          : promise
            ? { on: promise.dueOn, source: 'promised' }
            : predicted
              ? { on: predicted, source: 'predicted' }
              : undefined;

      const leverRows: Lever[] = LEVERS.map((l) => {
        const row = (leversBy.get(client.id) ?? []).find((r) => r.lever === l.key);
        return { ...l, state: row?.state ?? 'not_used', detail: row?.detail ?? '' };
      });
      const restricted = leverRows.some((l) => l.state === 'limited' || l.state === 'off');
      const waiting = (itemsBy.get(client.id) ?? []).filter(
        (w) => OPEN.includes(w.state) && !w.autoApplied,
      );

      const status: ClientRow['status'] = waiting.length
        ? { label: 'Awaiting approval', tone: 'info' }
        : client.status === 'held'
          ? { label: 'Held', tone: 'bad' }
          : client.status === 'restricted' || restricted
            ? { label: 'Restricted', tone: 'bad' }
            : client.status === 'prepay'
              ? { label: 'Prepay', tone: 'warn' }
              : cure
                ? { label: 'Cure period', tone: 'warn' }
                : overdue.length
                  ? {
                      label: inDefault ? 'Overdue' : 'In grace',
                      tone: inDefault ? 'warn' : 'neutral',
                    }
                  : { label: 'Current', tone: 'good' };

      const next = waiting.length
        ? `Approve: ${waiting[0]!.title}`
        : cure
          ? `Cure period ends ${shortDate(cure.dueOn)}`
          : overdue.length && cureOver && !restricted
            ? 'Eligible for restriction'
            : overdue.length && inDefault && !restricted
              ? 'Default notice due'
              : promise
                ? `Check payment on ${shortDate(promise.dueOn)}`
                : restricted && !overdue.length
                  ? 'Restore access'
                  : restricted
                    ? 'Restores when paid'
                    : '—';

      return {
        client,
        contract,
        unpaidCents: sum(unpaid),
        overdueCents: sum(overdue),
        disputedCents: sum(unpaid.filter((i) => i.status === 'disputed')),
        daysPastDue,
        inDefault,
        expected,
        status,
        levers: leverRows,
        waiting,
        next,
        flagged: flags.some((f) => f.clientId === client.id && f.status === 'flagged'),
        invoices: [...own].sort((a, b) => (a.dueOn < b.dueOn ? 1 : -1)),
      };
    });
  }, [today, clients, contracts, invoices, levers, deadlines, items, profiles, flags]);
}
