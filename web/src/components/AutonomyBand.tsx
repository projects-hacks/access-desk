import { useMemo, type CSSProperties } from 'react';
import { Bot, Hand, Landmark, Scale } from 'lucide-react';
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
  const [metrics] = useTable(tables.metricSnapshot.where((r) => r.metric.eq('share_needing_human')));
  const now = useNow();

  const d = useMemo(() => {
    const auto = items.filter((w) => w.autoApplied).length;
    const waiting = items.filter((w) => (w.state === 'PROPOSED' || w.state === 'NEEDS_INFO') && !w.autoApplied).length;
    const posted = feed.filter((m) => m.status === 'posted');
    const handled = posted.filter((m) => m.matchStatus !== 'unmatched' && m.matchStatus !== 'exception').length;
    return { auto, total: items.length, waiting, handled, posted: posted.length, pending: feed.length - posted.length };
  }, [items, feed]);
  const trend = useMemo(() => [...metrics].sort((a, b) => a.weekEnding.localeCompare(b.weekEnding)).slice(-12), [metrics]);

  const bank = sources.find((s) => s.source === 'bank');
  const synced = bank?.lastSyncAt ? ago(now - Number(bank.lastSyncAt.microsSinceUnixEpoch / 1000n)) : '-';
  const tied = run && run.unexplainedCents === 0n;

  return (
    <div className="band reveal" style={{ '--d': '0ms' } as CSSProperties}>
      <div className="band-cell">
        <div className="eyebrow band-label"><Bot size={14} aria-hidden /> Decided on its own</div>
        <div className="band-value">
          {d.total ? percent(d.auto / d.total) : <span className="muted">-</span>}
          <span className="band-sub">{d.auto} of {d.total} decisions</span>
        </div>
        {trend.length > 1 && (
          <div className="band-trend" title="Share of decisions that needed a person, four-week rolling, by week">
            <Sparkline values={trend.map((m) => m.value)} />
            <span className="band-sub">
              needed a person: {Math.round(trend[0]!.value)}% → {trend.at(-1)!.value.toFixed(1)}% in {trend.length} weeks
            </span>
          </div>
        )}
      </div>
      <div className="band-cell">
        <div className="eyebrow band-label"><Hand size={14} aria-hidden /> Waiting on you</div>
        <div className={`band-value ${d.waiting ? 'warn' : 'good'}`}>
          {d.waiting}
          <span className="band-sub">{d.waiting ? 'decisions only a person can make' : 'nothing needs you'}</span>
        </div>
      </div>
      <div className="band-cell">
        <div className="eyebrow band-label"><Landmark size={14} aria-hidden /> Bank feed · Nessie</div>
        <div className="band-value">
          {d.handled}/{d.posted}
          <span className="band-sub">read and settled{d.pending ? ` · ${d.pending} in transit` : ''} · synced {synced}</span>
        </div>
      </div>
      <div className="band-cell">
        <div className="eyebrow band-label"><Scale size={14} aria-hidden /> Books</div>
        <div className={`band-value ${!run ? '' : tied ? 'good' : 'bad'}`}>
          {!run ? <span className="muted">-</span> : tied ? 'Tied' : money(run.unexplainedCents)}
          <span className="band-sub">{!run ? 'no tie-out yet' : tied ? 'bank = ledger, to the cent' : 'unexplained · sent to a controller'}</span>
        </div>
      </div>
    </div>
  );
}

/** A small line that draws itself in, from oldest to newest. */
function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${24 - ((v - min) / (max - min || 1)) * 20}`)
    .join(' ');
  const [lx, ly] = points.split(' ').at(-1)!.split(',');
  return (
    <svg className="sparkline" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
      <polyline points={points} />
      {/* A zero-length line with a round cap stays a circle however the chart stretches. */}
      <polyline className="end" points={`${lx},${ly} ${lx},${ly}`} />
    </svg>
  );
}
