import { useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { Download } from 'lucide-react';
import { Hint } from '../components/Hint';
import { SlidingPill } from '../components/SlidingPill';
import { sameNews } from '../lib/agents';
import { actor, agentOf } from '../lib/bank';
import { LEVERS } from '../lib/clients';
import { bulletLines, label, plainText, simDay } from '../lib/format';
import { useSimTime } from '../lib/session';
import { tables } from '../module_bindings';
import type { AuditEvent } from '../module_bindings/types';

const PEOPLE = ['CONTROLLER', 'RELATIONSHIP_MANAGER', 'ACCOUNTANT', 'ADMIN'];

/** Bookkeeping between the server and the database: true, but not something a person reviews. */
const PLUMBING = new Set([
  'COMMAND_QUEUED',
  'COMMAND_DONE',
  'COMMAND_REQUEUED',
  'TIE_OUT',
  'SET_PLATFORM',
  'ASSIGN_ROLE',
  'SET_CLOCK',
  'CLOCK_SPEED',
  'RESET_WORLD',
  'CREDIT_SCORED',
]);

const ACCESS = new Set([
  'HOLD_PLACED',
  'HOLD_RELEASED',
  'LEVER_SET',
  'TIER_CHANGED',
  'WITHDRAWAL_REQUESTED',
  'EXPLOIT_FLAGGED',
]);
const PAYMENTS = new Set([
  'CASH_RECEIVED',
  'CASH_RECONCILED',
  'CASH_IN_TRANSIT',
  'CASH_REMOVED',
  'APPLICATIONS_REVERSED',
]);

const isPerson = (e: AuditEvent) => PEOPLE.includes(e.actorRole);
/** Attempts a guardrail stopped: an agent's action, a client's order, an approval that wasn't allowed. */
const REFUSALS = new Set(['GUARDRAIL_REFUSED', 'ORDER_REFUSED', 'TRANSITION', 'TIER_CHANGED']);
const isRefused = (e: AuditEvent) => !e.allowed && REFUSALS.has(e.action);
/** The gateway confirming its own commands (APPROVED → POSTED) repeats what was already logged. */
const isEcho = (e: AuditEvent) => e.action === 'TRANSITION' && e.toState === 'POSTED';

const FILTERS = {
  all: {
    label: 'All',
    // Bank-feed arrivals are hundreds of rows; they live under Payments.
    test: (e: AuditEvent) => e.action !== 'CASH_RECEIVED',
  },
  agents: { label: 'By agents', test: (e: AuditEvent) => e.actorRole === 'AGENT' },
  people: { label: 'Changed by people', test: isPerson },
  refused: { label: 'Refused', test: isRefused },
  access: { label: 'Access', test: (e: AuditEvent) => ACCESS.has(e.action) },
  payments: { label: 'Payments', test: (e: AuditEvent) => PAYMENTS.has(e.action) },
  notes: { label: 'Notes', test: (e: AuditEvent) => e.action === 'RM_NOTE' },
  deadlines: { label: 'Deadlines', test: (e: AuditEvent) => e.action.startsWith('DEADLINE') },
} as const;

type FilterKey = keyof typeof FILTERS;

const PAGE = 150;

/** What happened, in order, by whom. Every row is something that took effect. */
export function AuditLog() {
  const [events, ready] = useTable(tables.auditEvent);
  const [clients] = useTable(tables.client);
  const [items] = useTable(tables.workItem);
  const [policies] = useTable(tables.policy);
  const simTime = useSimTime();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const clientName = useMemo(() => new Map([...clients.map((c) => [c.id, c.name] as const), ['books', 'The books'] as const]), [clients]);
  const reasoning = useMemo(() => new Map(items.map((w) => [w.id, w])), [items]);
  /** Policy id → its current title (the active version, else the newest). */
  const policyTitle = useMemo(() => {
    const out = new Map<string, { title: string; version: number; active: boolean }>();
    for (const p of policies) {
      const was = out.get(p.policyId);
      const active = p.status === 'active';
      if (!was || (active && !was.active) || (active === was.active && p.version > was.version)) out.set(p.policyId, { title: p.title, version: p.version, active });
    }
    return out;
  }, [policies]);

  // What took effect, plus the attempts a guardrail stopped; plumbing never shows.
  const visible = useMemo(
    () =>
      events
        .filter((e) => (e.allowed || isRefused(e)) && !PLUMBING.has(e.action) && !isEcho(e))
        .sort((a, b) => (a.id < b.id ? 1 : -1)),
    [events],
  );

  /** Ids of person-made access changes that came after the agent had restricted that client. */
  const overrides = useMemo(() => {
    const out = new Set<bigint>();
    const restrictedBy = new Map<string, AuditEvent>();
    const restricts = (e: AuditEvent) =>
      e.action === 'HOLD_PLACED' ||
      (e.action === 'LEVER_SET' && (e.toState === 'limited' || e.toState === 'off'));
    for (const e of [...visible].reverse()) {
      if (!ACCESS.has(e.action) || !e.clientId) continue;
      if (!isPerson(e)) {
        if (restricts(e)) restrictedBy.set(e.clientId, e);
      } else if (restrictedBy.has(e.clientId)) out.add(e.id);
    }
    return { ids: out, restrictedBy };
  }, [visible]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return visible.filter((e) => {
      if (!FILTERS[filter].test(e)) return false;
      if (!words.length) return true;
      const text = [clientName.get(e.clientId) ?? '', e.clientId, e.detail, who(e), e.action]
        .join(' ')
        .toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [visible, filter, query, clientName, reasoning]);

  function who(e: AuditEvent) {
    return actor(e, e.workItemId !== undefined ? reasoning.get(e.workItemId)?.kind : undefined);
  }

  /** The current view as CSV, for an auditor's spreadsheet. */
  function download() {
    const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = shown.map((e) => [
      e.simDate, simTime(e.at, e.simDate), who(e), sentence(e), clientName.get(e.clientId) ?? e.clientId,
      plainText(e.detail, clientName), e.allowed ? 'took effect' : 'refused', e.policyRef ? (policyTitle.get(e.policyRef)?.title ?? '') : '',
    ]);
    const csv = [['Business day', 'Time', 'Who', 'What', 'Client', 'Detail', 'Outcome', 'Policy'], ...rows].map((r) => r.map(cell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `audit-log-${filter}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  }

  const days = useMemo(() => {
    const out: { day: string; events: AuditEvent[] }[] = [];
    for (const e of shown.slice(0, limit)) {
      const last = out.at(-1);
      if (last?.day === e.simDate) last.events.push(e);
      else out.push({ day: e.simDate, events: [e] });
    }
    return out;
  }, [shown, limit]);

  return (
    <section>
      <div className="screen-head">
        <div>
          <h2>Audit log</h2>
          <p className="muted">
            Everything that took effect, newest first: what the agents did, what people changed after
            them, and every attempt a guardrail stopped.
          </p>
        </div>
        <button className="btn" onClick={download} disabled={!shown.length}>
          <Download size={14} aria-hidden /> Download CSV
        </button>
      </div>

      <div className="filters" role="toolbar" aria-label="Filter the audit log">
        <input
          type="search"
          className="search"
          placeholder="Search clients or details…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE);
          }}
          aria-label="Search the audit log"
        />
        <div className="segmented">
          <SlidingPill active={filter} className="dark" />
          {(Object.keys(FILTERS) as FilterKey[]).map((key) => (
            <button
              key={key}
              className={`filter ${filter === key ? 'active' : ''}`}
              data-active={filter === key}
              aria-pressed={filter === key}
              onClick={() => {
                setFilter(key);
                setLimit(PAGE);
              }}
            >
              {FILTERS[key].label}
              <span className="count">{visible.filter(FILTERS[key].test).length}</span>
            </button>
          ))}
        </div>
      </div>

      {!ready ? (
        <div className="empty">Loading the audit log…</div>
      ) : days.length === 0 ? (
        <div className="empty">
          {filter === 'people'
            ? 'No one has changed anything by hand yet.'
            : filter === 'refused'
              ? 'No guardrail has had to stop anything yet.'
            : query
              ? `Nothing matches “${query}”.`
              : 'Nothing here yet.'}
        </div>
      ) : (
        <div className="activity">
          {days.map(({ day, events: dayEvents }) => (
            <div key={day} className="activity-day">
              <h3 className="activity-date">{simDay(day)}</h3>
              <ol className="activity-list">
                {dayEvents.map((e) => {
                  const override = overrides.ids.has(e.id);
                  const item = e.workItemId !== undefined ? reasoning.get(e.workItemId) : undefined;
                  // A person's own words, when this came from something they applied by hand.
                  const why = isPerson(e) && item?.policyRef === 'manual' ? item.reasoning : '';
                  const after = override ? overrides.restrictedBy.get(e.clientId) : undefined;
                  return (
                    <li key={String(e.id)} className={isRefused(e) ? 'refused' : isPerson(e) ? 'by-person' : ''}>
                      <span className="activity-time">{simTime(e.at, e.simDate)}</span>
                      <div className="activity-body">
                        <div className="activity-line">
                          <Actor e={e} name={who(e)} kind={item?.kind} />
                          <span className="activity-what">{sentence(e)}</span>
                          {e.clientId && (
                            <span className="activity-client">
                              {clientName.get(e.clientId) ?? e.clientId}
                            </span>
                          )}
                        </div>
                        {e.detail && !sameNews(e.detail, sentence(e), clientName.get(e.clientId)) && (
                          <Prose className="muted activity-detail" text={e.detail} names={clientName} />
                        )}
                        {override && (
                          <div className="activity-override">
                            Changed after the agent's restriction
                            {after
                              ? ` (${label(after.action).toLowerCase()}, ${simDay(after.simDate)})`
                              : ''}
                          </div>
                        )}
                        {why && (bulletLines(why)
                          ? <Prose className="activity-why" text={why} names={clientName} />
                          : <blockquote className="activity-why">“{why}”</blockquote>)}
                        {e.policyRef && e.policyRef !== 'manual' && (
                          <span className="activity-policy">
                            Under policy: {policyTitle.get(e.policyRef.split(':')[0]!)?.title ?? plainText(e.policyRef)}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
          {shown.length > limit && (
            <button className="btn" onClick={() => setLimit(limit + PAGE)}>
              Show older ({shown.length - limit} more)
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Actor({ e, name, kind }: { e: AuditEvent; name: string; kind?: string }) {
  if (isPerson(e)) return <span className="actor person">{name || label(e.actorRole)}</span>;
  if (e.actorRole === 'AGENT') {
    const a = agentOf(e, kind);
    return (
      <Hint title={a.name} role={a.role} about={a.purpose}>
        <span className="actor agent">{a.name} · {a.role}</span>
      </Hint>
    );
  }
  return <span className="actor system">{name}</span>;
}

const leverName = (subjectId: string) =>
  LEVERS.find((l) => subjectId.endsWith(`:${l.key}`))?.name ?? 'Access';

/** One plain sentence per event; the detail line underneath carries the specifics. */
function sentence(e: AuditEvent): string {
  switch (e.action) {
    case 'HOLD_PLACED':
      return 'Held withdrawals';
    case 'HOLD_RELEASED':
      return 'Released the withdrawal hold';
    case 'LEVER_SET':
      return `${leverName(e.subjectId)}: ${e.fromState || '?'} → ${e.toState || '?'}`;
    case 'TIER_CHANGED':
      return e.allowed ? `Tier ${e.fromState} → ${e.toState}` : 'Tier change not applied';
    case 'PROPOSE':
      return 'Proposed for approval';
    case 'AUTO_APPLIED':
      return e.actorRole === 'AGENT' || !PEOPLE.includes(e.actorRole)
        ? 'Applied under policy'
        : 'Applied';
    case 'TRANSITION':
      return e.allowed ? label(e.toState ?? '') : `Not allowed: ${label(e.toState ?? '').toLowerCase()}`;
    case 'RM_NOTE':
      return 'Added a note';
    case 'CASH_RECEIVED':
      return 'Payment received';
    case 'CASH_RECONCILED':
      return 'Payment matched';
    case 'CASH_IN_TRANSIT':
      return 'Payment on its way';
    case 'APPLICATIONS_REVERSED':
      return 'Payment reversed';
    case 'DEADLINE_SET':
      return 'Deadline set';
    case 'DEADLINE_DUE':
      return 'Deadline reached';
    case 'DEADLINE_MET':
      return 'Deadline met';
    case 'EXPLOIT_FLAGGED':
      return 'Flagged a possible exploit';
    case 'WITHDRAWAL_REQUESTED':
      return 'Withdrawal requested';
    case 'AGENT_WAITED':
      return 'Held off acting';
    case 'ADVANCE_CLOCK':
      return 'Moved the date forward';
    case 'GUARDRAIL_REFUSED':
      return 'Refused by a guardrail';
    case 'LEARNED':
      return 'Lesson recorded from a rejection';
    case 'POLICY_OUTCOME':
      return e.toState === 'passing' ? 'Client policy is working' : 'Client policy is not working yet';
    case 'POLICY_ACTIVATED':
      return 'Client policy put in force';
    case 'ORDER_REFUSED':
      return 'Order refused';
    case 'ORDER_PLACED':
      return 'Order placed';
    default:
      return label(e.action);
  }
}

/** Text a person or agent wrote: "- " points as a list, anything else as one line. */
function Prose({ text, names, className }: { text: string; names: Map<string, string>; className: string }) {
  const lines = bulletLines(text);
  if (!lines) return <div className={className}>{plainText(text, names)}</div>;
  return (
    <ul className={`${className} activity-points`}>
      {lines.map((l, i) => <li key={i}>{plainText(l, names)}</li>)}
    </ul>
  );
}
