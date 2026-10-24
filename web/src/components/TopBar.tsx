import { useMemo, useState, type CSSProperties } from 'react';
import { useTable } from 'spacetimedb/react';
import { actor, isNews } from '../lib/bank';
import { tables } from '../module_bindings';
import { demo } from '../lib/demo';
import { label, simDay } from '../lib/format';
import { useClock, usePlatform, useSession } from '../lib/session';

const CONTROLS = [
  { label: '+1 day', path: 'advance', body: { days: 1 } },
  { label: '+7 days', path: 'advance', body: { days: 7 } },
  { label: 'Settle wire', path: 'settle', body: { bankRef: 'WI-5531' } },
] as const;

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
            {busy === c.label ? '…' : c.label}
          </button>
        ))}
        <button className="btn ghost" disabled={!!busy} onClick={reset}>
          {busy === 'Reset' ? '…' : 'Reset'}
        </button>
      </div>
      <AgentTicker />
      {message && <div className={`topbar-message ${message.tone}`}>{message.text}</div>}
    </div>
  );
}

/** The latest thing the desk did, live: each new decision or money event slides in. */
function AgentTicker() {
  const [audit] = useTable(tables.auditEvent);
  const last = useMemo(
    () => audit.reduce<(typeof audit)[number] | undefined>((best, e) => (isNews(e) && (!best || e.id > best.id) ? e : best), undefined),
    [audit],
  );
  if (!last) return null;
  return (
    <div className="ticker" aria-live="polite">
      <span className="ticker-dot" />
      <span key={String(last.id)} className="ticker-text">
        <strong>{actor(last)}</strong> · {label(last.action)}
        {last.detail && <span className="muted"> · {last.detail}</span>}
      </span>
    </div>
  );
}

/** Connection state and who this browser is acting as. */
export function SessionPill() {
  const session = useSession();
  return (
    <div className="topbar-session">
      <span className={`dot ${session.connected ? 'on' : 'off'}`} />
      <span>
        {session.connected ? 'Live' : session.error ? 'Connection error' : 'Connecting…'}
        {' · '}
        {session.role ? `${session.name ?? 'You'} (${session.role.toLowerCase()})` : 'read-only'}
      </span>
    </div>
  );
}
