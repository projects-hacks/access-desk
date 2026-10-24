import { useMemo, type CSSProperties } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { ago, useBankFeed, useLatestTieOut, useNow } from '../lib/bank';
import { money, percent } from '../lib/format';

/**
 * What the desk did on its own, in four numbers: decisions made without a person,
 * what's waiting on one, bank movements read and matched, and whether the books tie.
 */
export function AutonomyBand() {
  const [items] = useTable(tables.workItem);
  const [feed] = useBankFeed();
  const { run } = useLatestTieOut();
  const [sources] = useTable(tables.syncSource);
  const now = useNow();

  const d = useMemo(() => {
    const auto = items.filter((w) => w.autoApplied).length;
    const waiting = items.filter((w) => (w.state === 'PROPOSED' || w.state === 'NEEDS_INFO') && !w.autoApplied).length;
    const posted = feed.filter((m) => m.status === 'posted');
    const handled = posted.filter((m) => m.matchStatus !== 'unmatched' && m.matchStatus !== 'exception').length;
    return { auto, total: items.length, waiting, handled, posted: posted.length, pending: feed.length - posted.length };
  }, [items, feed]);

  const bank = sources.find((s) => s.source === 'bank');
  const synced = bank?.lastSyncAt ? ago(now - Number(bank.lastSyncAt.microsSinceUnixEpoch / 1000n)) : '—';
  const tied = run && run.unexplainedCents === 0n;

  return (
    <div className="band reveal" style={{ '--d': '0ms' } as CSSProperties}>
      <div className="band-cell">
        <div className="eyebrow">Decided on its own</div>
        <div className="band-value">
          {d.total ? percent(d.auto / d.total) : '—'}
          <span className="band-sub">{d.auto} of {d.total} decisions</span>
        </div>
      </div>
      <div className="band-cell">
        <div className="eyebrow">Waiting on you</div>
        <div className={`band-value ${d.waiting ? 'warn' : 'good'}`}>
          {d.waiting}
          <span className="band-sub">{d.waiting ? 'top clients, offboarding, unknowns' : 'nothing needs you'}</span>
        </div>
      </div>
      <div className="band-cell">
        <div className="eyebrow">Bank feed · Nessie</div>
        <div className="band-value">
          {d.handled}/{d.posted}
          <span className="band-sub">read and settled{d.pending ? ` · ${d.pending} in transit` : ''} · synced {synced}</span>
        </div>
      </div>
      <div className="band-cell">
        <div className="eyebrow">Books</div>
        <div className={`band-value ${!run ? '' : tied ? 'good' : 'bad'}`}>
          {!run ? '—' : tied ? 'Tied' : money(run.unexplainedCents)}
          <span className="band-sub">{!run ? 'no tie-out yet' : tied ? 'bank = ledger, to the cent' : 'unexplained · sent to a controller'}</span>
        </div>
      </div>
    </div>
  );
}
