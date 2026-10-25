import { useMemo, useState, type CSSProperties } from 'react';
import {
  Activity, ArrowDownLeft, ArrowUpRight, Banknote, Bot, CalendarClock, CalendarDays, CalendarPlus, CheckCircle2, Gauge, Lock,
  RotateCcw, SlidersHorizontal, Sparkles, Timer, Unlock, XCircle, Zap, type LucideIcon,
} from 'lucide-react';
import { useTable } from 'spacetimedb/react';
import { actor, ago, eventMs, isNews, narrate, useNow } from '../lib/bank';
import { seat, switchController, type Seat } from '../lib/config';
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

/** Icon for what kind of thing happened. */
const ACTION_ICON: Record<string, LucideIcon> = {
  AUTO_APPLIED: Bot, PROPOSE: Sparkles, CASH_RECEIVED: ArrowDownLeft, CASH_IN_TRANSIT: ArrowDownLeft,
  HOLD_PLACED: Lock, HOLD_RELEASED: Unlock, LEVER_SET: SlidersHorizontal, WITHDRAWAL_REQUESTED: ArrowUpRight,
  DEADLINE_SET: Timer, DEADLINE_DUE: Timer, DEADLINE_MET: Timer, ADVANCE_CLOCK: CalendarClock, TIER_CHANGED: Gauge,
};

/** Long wallet addresses and record ids read as 0xa47d…7b9c. */
const tidy = (text: string) => text.replace(/\b(0x[0-9a-fA-F]{4})[0-9a-fA-F]{8,}([0-9a-fA-F]{4})\b/g, '$1…$2');

/** What the desk has been doing, live: the last few actions in turn, a new one jumps to the front. */
function AgentTicker() {
  const [audit] = useTable(tables.auditEvent);
  const [items] = useTable(tables.workItem);
  const session = useSession();
  const now = useNow(1000);
  const recent = useMemo(
    () => audit.filter(isNews).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 6),
    [audit],
  );
  // Rotate every 4.5 s; restart from the newest whenever something new happens.
  const newest = recent[0]?.id;
  const [shownAt, setShownAt] = useState({ id: newest, at: Date.now() });
  if (newest !== shownAt.id) setShownAt({ id: newest, at: Date.now() });
  if (!recent.length) return null;
  // `now` can lag the reset of shownAt by a tick; never let the index go negative.
  const e = recent[Math.max(0, Math.floor((now - shownAt.at) / 4500)) % recent.length]!;
  const title = e.workItemId !== undefined ? items.find((w) => w.id === e.workItemId)?.title : undefined;
  const { verb, what } = narrate(e, title);
  const who = session.name && e.actorName === session.name ? 'You' : actor(e);
  const Icon = e.action === 'TRANSITION' ? (e.allowed && e.toState !== 'REJECTED' ? CheckCircle2 : XCircle) : ACTION_ICON[e.action] ?? Activity;
  return (
    <div className="ticker" aria-live="polite">
      <span className="ticker-badge"><Zap size={12} aria-hidden />Live</span>
      <span key={String(e.id)} className="ticker-text">
        <Icon size={14} aria-hidden className="ticker-icon" />
        <strong>{who}</strong> {verb}
        {what && <span className="muted"> · {tidy(what)}</span>}
      </span>
      <span className="ticker-time eyebrow">{ago(now - eventMs(e))}</span>
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
      {session.connected && !session.role && <span>Read-only</span>}
      {/* Two seats, because nobody approves their own proposal: A proposes, B approves. */}
      {session.role && (
        <span className="seats" role="group" aria-label="Acting as">
          {(['a', 'b'] as Seat[]).map((s) => (
            <button
              key={s}
              className={s === seat ? 'active' : ''}
              aria-pressed={s === seat}
              onClick={() => s !== seat && switchController(s)}
              title={`Act as Controller ${s.toUpperCase()}`}
            >
              Controller {s.toUpperCase()}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
