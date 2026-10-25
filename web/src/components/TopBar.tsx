import { useMemo, useState, type CSSProperties } from 'react';
import { Banknote, CalendarClock, CalendarDays, CalendarPlus, RotateCcw, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import { useTable } from 'spacetimedb/react';
import { actor, ago, eventMs, isNews, narrate, useNow } from '../lib/bank';
import { tables } from '../module_bindings';
import { demo } from '../lib/demo';
import { simDay } from '../lib/format';
import { useClock, usePlatform, useSession } from '../lib/session';

const CONTROLS: { label: string; path: string; body: object; icon: LucideIcon }[] = [
  { label: '+1 day', path: 'advance', body: { days: 1 }, icon: CalendarPlus },
  { label: '+7 days', path: 'advance', body: { days: 7 }, icon: CalendarDays },
  { label: 'Settle wire', path: 'settle', body: { bankRef: 'WI-5531' }, icon: Banknote },
];

/** Sim date and the demo controls. */
export function TopBar() {
  const clock = useClock();
  const platform = usePlatform();
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string }>();

  async function run(name: string, path: string, body: object) {
    setBusy(name);
    setMessage(undefined);
    try {
      await demo(path, body);
      setMessage({ tone: 'good', text: `${name}: done` });
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(undefined);
    }
  }

  function reset() {
    if (
      confirm('Reset the bank and the shared database to Tue Mar 3? Everyone on the team sees it.')
    ) {
      void run('Reset', 'reset', {});
    }
  }

  return (
    <div className="topbar reveal" style={{ '--d': '60ms' } as CSSProperties}>
      <div className="topbar-date">
        <CalendarClock className="ico muted" size={16} aria-hidden />
        <span className="eyebrow">{platform?.name ?? 'Platform'} · sim date</span>
        <strong>{simDay(clock?.simDate)}</strong>
        {clock && clock.secondsPerDay > 0 && (
          <span className="eyebrow">running · 1 day / {clock.secondsPerDay}s</span>
        )}
      </div>
      <div className="topbar-controls">
        {CONTROLS.map((c) => (
          <button
            key={c.label}
            className="btn"
            disabled={!!busy}
            onClick={() => run(c.label, c.path, c.body)}
          >
            <c.icon size={14} aria-hidden />
            {busy === c.label ? '…' : c.label}
          </button>
        ))}
        <button className="btn ghost" disabled={!!busy} onClick={reset}>
          <RotateCcw size={14} aria-hidden />
          {busy === 'Reset' ? '…' : 'Reset'}
        </button>
      </div>
      <AgentTicker />
      {message && <div className={`topbar-message ${message.tone}`}>{message.text}</div>}
    </div>
  );
}

/** The latest thing the desk did, live: each new decision or money event slides in as a sentence. */
function AgentTicker() {
  const [audit] = useTable(tables.auditEvent);
  const [items] = useTable(tables.workItem);
  const session = useSession();
  const now = useNow(5000);
  const last = useMemo(
    () => audit.reduce<(typeof audit)[number] | undefined>((best, e) => (isNews(e) && (!best || e.id > best.id) ? e : best), undefined),
    [audit],
  );
  if (!last) return null;
  const title = last.workItemId !== undefined ? items.find((w) => w.id === last.workItemId)?.title : undefined;
  const { verb, what } = narrate(last, title);
  const who = session.name && last.actorName === session.name ? 'You' : actor(last);
  return (
    <div className="ticker" aria-live="polite">
      <span className="ticker-badge"><Zap size={12} aria-hidden />Live</span>
      <span key={String(last.id)} className="ticker-text">
        <strong>{who}</strong> {verb}
        {what && <span className="muted"> · {what}</span>}
      </span>
      <span className="ticker-time eyebrow">{ago(now - eventMs(last))}</span>
    </div>
  );
}

/** Connection state and who this browser is acting as. */
export function SessionPill() {
  const session = useSession();
  return (
    <div
      className="topbar-session"
      title={`${session.connected ? 'Connected live to SpacetimeDB' : 'Not connected'} · ${session.role ? `acting as ${session.name ?? 'you'} (${session.role.toLowerCase()})` : 'read-only'}`}
    >
      <span className={`dot ${session.connected ? 'on' : 'off'}`} />
      {!session.connected && <span>{session.error ? 'Connection error' : 'Connecting…'}</span>}
      {session.connected && (session.role ? <><ShieldCheck size={14} aria-hidden /><span>{session.name ?? 'You'}</span></> : <span>Read-only</span>)}
    </div>
  );
}
