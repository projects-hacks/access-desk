import { useMemo, useState, type CSSProperties } from 'react';
import {
  Activity, ArrowDownLeft, ArrowUpRight, Bot, CalendarClock, CheckCircle2, Gauge, Lock, ShieldX, SlidersHorizontal, Sparkles, Timer,
  Unlock, XCircle, Zap, type LucideIcon,
} from 'lucide-react';
import { useTable } from 'spacetimedb/react';
import { actor, ago, eventMs, isNews, narrate, useNow } from '../lib/bank';
import { tables } from '../module_bindings';
import { label, simDay } from '../lib/format';
import { useClock, usePlatform, useSession } from '../lib/session';

/** What the desk is doing right now (on a phone, with the business date). */
export function TopBar() {
  return (
    <div className="topbar reveal" style={{ '--d': '60ms' } as CSSProperties}>
      <PlatformDate compact />
      <AgentTicker />
    </div>
  );
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The platform the desk runs and its business date, as a calendar tile. */
export function PlatformDate({ compact = false }: { compact?: boolean }) {
  const clock = useClock();
  const platform = usePlatform();
  const date = clock?.simDate;
  const d = date ? new Date(`${date}T12:00:00Z`) : undefined;
  return (
    <div className={`platform-date ${compact ? 'compact' : ''}`} title={`${platform?.name ?? 'Platform'} · business date ${simDay(date)}`}>
      <span className="platform-mark" aria-hidden>
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 1.5 14.2 9.8 22.5 12 14.2 14.2 12 22.5 9.8 14.2 1.5 12 9.8 9.8Z" fill="currentColor" /></svg>
      </span>
      <span className="platform-name">{platform?.name ?? 'Platform'}</span>
      {d && (
        <span className="cal" aria-label={simDay(date)}>
          <span className="cal-tile">
            <span className="cal-month">{MONTH[d.getUTCMonth()]}</span>
            <span className="cal-day">{d.getUTCDate()}</span>
          </span>
          <span className="cal-weekday">{WEEKDAY[d.getUTCDay()]}</span>
        </span>
      )}
    </div>
  );
}

/** Icon for what kind of thing happened. */
const ACTION_ICON: Record<string, LucideIcon> = {
  AUTO_APPLIED: Bot, PROPOSE: Sparkles, CASH_RECEIVED: ArrowDownLeft, CASH_IN_TRANSIT: ArrowDownLeft,
  HOLD_PLACED: Lock, HOLD_RELEASED: Unlock, LEVER_SET: SlidersHorizontal, WITHDRAWAL_REQUESTED: ArrowUpRight,
  DEADLINE_SET: Timer, DEADLINE_DUE: Timer, DEADLINE_MET: Timer, ADVANCE_CLOCK: CalendarClock, TIER_CHANGED: Gauge,
  GUARDRAIL_REFUSED: ShieldX, ORDER_REFUSED: ShieldX,
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
  const kind = e.workItemId !== undefined ? items.find((w) => w.id === e.workItemId)?.kind : undefined;
  const who = session.name && e.actorName === session.name ? 'You' : actor(e, kind);
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

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

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
      {session.role && (
        <span className="controller">
          <span className="controller-avatar" aria-hidden>{initials(session.name ?? '')}</span>
          <span className="controller-name">
            <strong>{session.name}</strong>
            <span>{session.role === 'CONTROLLER' ? 'Controller' : label(session.role)}</span>
          </span>
        </span>
      )}
    </div>
  );
}
