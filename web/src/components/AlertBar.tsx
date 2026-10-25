import { useMemo } from 'react';
import { OctagonAlert } from 'lucide-react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { useLatestTieOut } from '../lib/bank';
import { money } from '../lib/format';

/** Not approvals: things a person must see even though nothing waits on them. */
export const ALERT_KINDS = new Set(['BOOKS_BREAK', 'UNEXPLAINED_OUTFLOW', 'SYSTEM_EXCEPTION']);

/** A red line under the top bar while the books don't tie, money left without an instruction, or the gateway failed. */
export function AlertBar({ onOpen }: { onOpen: () => void }) {
  const [items] = useTable(tables.workItem);
  const { run } = useLatestTieOut();
  const tied = !run || run.unexplainedCents === 0n;
  const alerts = useMemo(
    () =>
      items
        // A books break stops being news once the latest tie-out ties again.
        .filter((w) => ALERT_KINDS.has(w.kind) && !(w.kind === 'BOOKS_BREAK' && tied))
        .sort((a, b) => (a.id < b.id ? 1 : -1)),
    [items, tied],
  );
  if (!alerts.length) return null;
  const top = alerts[0]!;
  return (
    <div className="alertbar" role="alert">
      <OctagonAlert size={16} aria-hidden />
      <strong>{alerts.length === 1 ? 'Alert' : `${alerts.length} alerts`}</strong>
      <span className="alertbar-text">
        {top.title}
        {top.amountCents > 0n && !top.title.includes('$') && ` · ${money(top.amountCents)}`}
      </span>
      <button className="link" onClick={onOpen}>Open bank & books</button>
    </div>
  );
}
