import { createContext, useContext, useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  AppWindow, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronUp, CircleCheck, Clock, Eye, Gauge, Hand, KeyRound, Landmark,
  Link2, Loader2, PanelRightClose, PlugZap, ShieldHalf, ShieldX, Sparkles, User, X, type LucideIcon,
} from 'lucide-react';
import { AGENTS, clock, EARLIER_LIMIT, isAgent, offset, useAgents, type EpisodeView, type Need } from '../lib/agents';
import type { EpisodeStep } from '../module_bindings/types';
import { Hint } from './Hint';

type Actor = { name: string; role?: string; about: string; icon: LucideIcon; hue: number; low?: boolean; ink?: boolean };

const agent = (key: string) => AGENTS.find((a) => a.key === key)!;

/** Who acted, how they look in the timeline. Hue is an oklch hue; `low` mutes plumbing, `ink` is the guardrail. */
const ACTORS: Record<string, Actor> = {
  bank: { name: 'Bank', about: 'The bank feed: wires, ACH and fees as they land.', icon: Landmark, hue: 195 },
  payment: { name: 'Payment checking', about: 'Matches each payment to invoices and ties the bank to the ledger.', icon: Link2, hue: 305 },
  platform: { name: 'Platform', about: 'The trading platform: client requests and access settings.', icon: AppWindow, hue: 255, low: true },
  scheduler: { name: 'Scheduler', about: 'Watches cure periods and promised payment dates.', icon: Clock, hue: 110 },
  learning: { name: agent('learning').name, role: agent('learning').role, about: agent('learning').purpose, icon: BookOpen, hue: 160 },
  scoring: { name: agent('scoring').name, role: agent('scoring').role, about: agent('scoring').purpose, icon: Gauge, hue: 280 },
  exploit: { name: agent('exploit').name, role: agent('exploit').role, about: agent('exploit').purpose, icon: Eye, hue: 50 },
  access: { name: agent('access').name, role: agent('access').role, about: agent('access').purpose, icon: KeyRound, hue: 235 },
  guardrail: { name: 'Guardrail', about: "Checks every agent action against policy and the contract before it happens.", icon: ShieldHalf, hue: 0, ink: true },
  gateway: { name: 'Gateway', about: 'Carries out approved changes at the platform and the bank.', icon: PlugZap, hue: 255, low: true },
  person: { name: 'Controller', about: 'A person on the desk making the call.', icon: User, hue: 345 },
};

/** Each agent's current status line, for the hover card on its name in the timeline. */
const StatusContext = createContext<Record<string, string>>({});

/** Click or Enter/Space on something that is not a button. */
const activate = (fn: () => void) => ({
  role: 'button' as const,
  tabIndex: 0,
  onClick: fn,
  onKeyDown: (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  },
});

const KINDS = {
  auto: { badge: 'Auto-handled', icon: CircleCheck },
  stopped: { badge: 'Guardrail stopped', icon: ShieldX },
  waiting: { badge: 'Waiting on a person', icon: Hand },
} as const;
const kindOf = (kind: string) => KINDS[kind as keyof typeof KINDS] ?? KINDS.auto;

/** Reveals an agent's reasoning, then its checks, one by one: only for steps that just arrived. */
function useReveal(step: EpisodeStep, animate: boolean) {
  const L = step.reason.length;
  const total = step.checks.length;
  const [typed, setTyped] = useState(0);
  const [checked, setChecked] = useState(0);
  useEffect(() => {
    if (!animate || typed >= L) return;
    const t = setTimeout(() => setTyped((c) => Math.min(L, c + Math.max(3, Math.ceil(L / 90)))), 48);
    return () => clearTimeout(t);
  }, [animate, typed, L]);
  useEffect(() => {
    if (!animate || typed < L || checked >= total) return;
    const t = setTimeout(() => setChecked((c) => c + 1), 320);
    return () => clearTimeout(t);
  }, [animate, typed, L, checked, total]);
  return animate ? { typed, checked } : { typed: L, checked: total };
}

function StepRow({ step, t0, last, animate }: { step: EpisodeStep; t0: number; last: boolean; animate: boolean }) {
  // Whether the step arrived live is decided once, when it first appears.
  const [live] = useState(animate);
  const [open, setOpen] = useState(false);
  const a: Actor = ACTORS[step.actor] ?? { name: step.actor, about: '', icon: Sparkles, hue: 255, low: true };
  const status = useContext(StatusContext)[step.actor];
  const Icon = a.icon;
  const { typed, checked } = useReveal(step, live);
  const typing = !!step.reason && typed < step.reason.length;
  const long = step.text.length > 140 || step.reason.length > 140;
  const at = Number(step.at.microsSinceUnixEpoch / 1000n);
  return (
    <li className={`ap-step ${live ? 'enter' : ''}`}>
      <span className="ap-rail">
        <span className={`ap-ico ${a.ink ? 'ink' : a.low ? 'low' : ''}`} style={{ '--h': a.hue } as CSSProperties}>
          <Icon size={14} aria-hidden />
        </span>
        {!last && <span className="ap-line" />}
      </span>
      <div className="ap-body">
        <div className="ap-who">
          {a.about ? (
            <Hint title={a.name} role={a.role} about={a.about} status={status}>
              <strong className={a.ink ? 'ink' : a.low ? 'low' : ''} style={{ '--h': a.hue } as CSSProperties}>{a.name}</strong>
            </Hint>
          ) : (
            <strong className="low" style={{ '--h': a.hue } as CSSProperties}>{a.name}</strong>
          )}
          {isAgent(step.actor) && <span className="ap-droid">· Droid</span>}
          {typing && <span className="ap-reasoning">reasoning</span>}
        </div>
        <div
          className={`ap-text ${open ? 'open' : ''} ${long ? 'long' : ''}`}
          {...(long ? activate(() => setOpen(!open)) : {})}
        >
          {step.text}
        </div>
        {step.reason && (
          <div
            className={`ap-reason ${open || typing ? 'open' : ''}`}
            {...activate(() => setOpen(!open))}
            aria-expanded={open}
            title={open ? 'Show less' : 'Show more'}
          >
            {`“${step.reason.slice(0, typed)}${typing ? '▍' : '”'}`}
          </div>
        )}
        {step.checks.length > 0 && !typing && (
          <div className="ap-checks">
            {step.checks.map((c, i) =>
              i >= checked ? (
                <span key={i} className="ap-check pending"><Loader2 size={12} aria-hidden />{c.label}</span>
              ) : (
                <span key={i} className={`ap-check ${c.ok ? 'ok' : 'no'}`}>
                  {c.ok ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
                  {c.label}
                </span>
              ),
            )}
          </div>
        )}
        {step.instead && checked >= step.checks.length && !typing && (
          <div className="ap-instead"><strong>Instead →</strong><span>{step.instead}</span></div>
        )}
      </div>
      <span className="ap-t mono">{offset(at - t0)}</span>
    </li>
  );
}

function Steps({ view, fresh }: { view: EpisodeView; fresh?: (s: EpisodeStep) => boolean }) {
  const t0 = view.steps[0] ? Number(view.steps[0].at.microsSinceUnixEpoch / 1000n) : 0;
  // The step that merely restates the trigger line above it adds nothing.
  const steps = view.steps.filter(
    (s, i) => !(i === 0 && view.steps.length > 1 && s.text === view.episode.trigger && !s.reason && !s.checks.length && !s.instead),
  );
  return (
    <ol className="ap-steps">
      {steps.map((s, i) => (
        <StepRow key={s.id} step={s} t0={t0} last={i === steps.length - 1} animate={!!fresh?.(s)} />
      ))}
    </ol>
  );
}

function NowCard({ view, fresh }: { view: EpisodeView; fresh: (s: EpisodeStep) => boolean }) {
  const kind = kindOf(view.episode.kind);
  const Outcome = kind.icon;
  const tone = view.running ? 'running' : view.episode.kind;
  return (
    <section className="ap-section">
      <h4 className="ap-head">{view.running ? 'Now' : 'Just now'}</h4>
      <div className={`ap-card ${tone}`}>
        <div className="ap-card-top">
          <div className="ap-card-meta">
            <span className={`ap-badge ${tone}`}>{view.running ? 'Running' : kind.badge}</span>
            <span className="ap-client">{view.clientName}</span>
          </div>
          <span className="ap-clock">
            {!view.running && view.totalMs > 0 ? offset(view.totalMs) : clock(view.episode.startedAt, true)}
          </span>
        </div>
        <div className="ap-trigger">{view.episode.trigger}</div>
        <Steps view={view} fresh={fresh} />
        {!view.running && view.episode.outcome && view.episode.outcome !== view.episode.trigger && (
          <div className={`ap-outcome ${view.episode.kind}`}>
            <Outcome size={16} aria-hidden />
            <span>{view.episode.outcome}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function EarlierRow({ view, open, onToggle }: { view: EpisodeView; open: boolean; onToggle: () => void }) {
  const kind = kindOf(view.episode.kind);
  const Icon = view.running ? Loader2 : kind.icon;
  return (
    <li className="ap-earlier">
      <button className="ap-row" onClick={onToggle} aria-expanded={open}>
        <Icon size={16} className={`ap-kind ${view.running ? 'running' : view.episode.kind}`} aria-hidden />
        <span className="ap-row-text">
          <span className="ap-row-trigger">{view.episode.trigger}</span>
          <span className={`ap-row-outcome ${view.episode.kind}`}>
            {view.episode.outcome && view.episode.outcome !== view.episode.trigger ? view.episode.outcome : kind.badge}
          </span>
        </span>
        <span className="ap-row-side">
          <span>{clock(view.episode.startedAt, true)}</span>
          {open ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
        </span>
      </button>
      {open && (
        <div className="ap-expanded">
          <Steps view={view} />
          <div className="ap-foot">
            <span>
              {view.clientName}
              {view.totalMs > 0 && ` · ${offset(view.totalMs)} end to end`}
            </span>
            <span>Logged to audit trail</span>
          </div>
        </div>
      )}
    </li>
  );
}

function NeedCard({ need, onOpen }: { need: Need; onOpen: () => void }) {
  return (
    <div className="ap-need">
      <div className="ap-need-text">
        <Hand size={16} aria-hidden />
        <span>
          <strong>{need.title}</strong>
          {need.detail && <span className="muted">{need.detail}</span>}
        </span>
      </div>
      <div className="ap-need-foot">
        <span>{need.clientName}</span>
        <button className="btn primary" onClick={onOpen}>
          Open in approvals <ArrowUpRight size={13} aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** The docked panel (a bottom sheet on narrow screens) showing the agents working, live from the database. */
export function AgentsPanel({ open, onToggle, onOpenApprovals }: { open: boolean; onToggle: () => void; onOpenApprovals: (need: Need) => void }) {
  const { roster, needs, now, earlier, total, working, isFresh } = useAgents();
  const [expanded, setExpanded] = useState<Set<bigint>>(new Set());
  const toggle = (id: bigint) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (!open) {
    return (
      <button className="ap-pill" onClick={onToggle} aria-label="Open agents panel">
        <span className="ap-pulse" />
        <span>{roster.length} agents · {working ? 'working' : 'live'}</span>
        {needs.length > 0 && <span className="ap-count">{needs.length}</span>}
      </button>
    );
  }

  return (
    <StatusContext.Provider value={Object.fromEntries(roster.map((r) => [r.key, r.status]))}>
      {/* Only shown on a phone: tapping outside the sheet puts it away. */}
      <div className="ap-backdrop" onClick={onToggle} />
    <aside className="ap" aria-label="Agents at work">
      <header className="ap-top">
        <div className="ap-title">
          <Sparkles size={16} aria-hidden />
          <h3>Agents at work</h3>
          <span className="ap-live"><span className="ap-pulse" />Live</span>
        </div>
        <button className="ap-collapse" onClick={onToggle} aria-label="Collapse to pill" title="Collapse">
          <PanelRightClose className="ap-side" size={15} aria-hidden />
          <ChevronDown className="ap-down" size={16} aria-hidden />
        </button>
      </header>
      <div className="ap-roster">
        {roster.map((r) => {
          const a = ACTORS[r.key]!;
          const Icon = a.icon;
          return (
            <Hint key={r.key} className="block" title={r.name} role={r.role} about={r.purpose} status={r.status}>
              <div className={`ap-chip ${r.working ? 'on' : ''}`}>
                <span className="ap-ico" style={{ '--h': a.hue } as CSSProperties}><Icon size={14} aria-hidden /></span>
                <span className="ap-chip-text">
                  <strong>{r.name}</strong>
                  <em>{r.role}</em>
                  <span>{r.status}</span>
                </span>
              </div>
            </Hint>
          );
        })}
      </div>
      <div className="ap-scroll">
        {needs.length > 0 && (
          <section className="ap-section">
            <h4 className="ap-head">Needs a person</h4>
            {needs.slice(0, 3).map((n) => (
              <NeedCard key={n.episodeId} need={n} onOpen={() => onOpenApprovals(n)} />
            ))}
            {needs.length > 3 && <p className="ap-more">+{needs.length - 3} more in approvals</p>}
          </section>
        )}
        {now && <NowCard view={now} fresh={isFresh} />}
        <section className="ap-section">
          <div className="ap-headrow">
            <h4 className="ap-head">Earlier</h4>
            {total > 0 && <span>{total > earlier.length + (now ? 1 : 0) ? `latest ${EARLIER_LIMIT} of ${total}` : `${total} episodes`}</span>}
          </div>
          {earlier.length ? (
            <ul className="ap-list">
              {earlier.map((v) => (
                <EarlierRow key={v.episode.id} view={v} open={expanded.has(v.episode.id)} onToggle={() => toggle(v.episode.id)} />
              ))}
            </ul>
          ) : (
            !now && <p className="ap-empty">Nothing yet. When something happens, the agents show up here.</p>
          )}
        </section>
      </div>
    </aside>
    </StatusContext.Provider>
  );
}
