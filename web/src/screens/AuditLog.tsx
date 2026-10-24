import { useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { SlidingPill } from '../components/SlidingPill';
import { LEVERS } from '../lib/clients';
import { label, simDay } from '../lib/format';
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
/** The gateway confirming its own commands (APPROVED → POSTED) repeats what was already logged. */
const isEcho = (e: AuditEvent) => e.action === 'TRANSITION' && e.toState === 'POSTED';

const FILTERS = {
  all: {
    label: 'All',
    // Bank-feed arrivals are hundreds of rows; they live under Payments.
    test: (e: AuditEvent) => e.action !== 'CASH_RECEIVED',
  },
  people: { label: 'Changed by people', test: isPerson },
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
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  const reasoning = useMemo(() => new Map(items.map((w) => [w.id, w])), [items]);

  // Only what took effect: refused attempts and plumbing never show.
  const visible = useMemo(
    () =>
      events
        .filter((e) => e.allowed && !PLUMBING.has(e.action) && !isEcho(e))
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
      const text = [clientName.get(e.clientId) ?? '', e.clientId, e.detail, e.actorName, e.action]
        .join(' ')
        .toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [visible, filter, query, clientName]);

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
          <h2>Activity</h2>
          <p className="muted">
            Everything that took effect, newest first: what the agents did, and what people changed
            after them.
          </p>
        </div>
      </div>

      <div className="filters" role="toolbar" aria-label="Filter activity">
        <input
          type="search"
          className="search"
          placeholder="Search clients or details…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE);
          }}
          aria-label="Search activity"
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
        <div className="empty">Loading activity…</div>
      ) : days.length === 0 ? (
        <div className="empty">
          {filter === 'people'
            ? 'No one has changed anything by hand yet.'
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
                    <li key={String(e.id)} className={isPerson(e) ? 'by-person' : ''}>
                      <span className="activity-time">
                        {e.at.toDate().toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                      <div className="activity-body">
                        <div className="activity-line">
                          <Actor e={e} />
                          <span className="activity-what">{sentence(e)}</span>
                          {e.clientId && (
                            <span className="activity-client">
                              {clientName.get(e.clientId) ?? e.clientId}
                            </span>
                          )}
                        </div>
                        {e.detail && e.detail !== sentence(e) && (
                          <div className="muted activity-detail">{e.detail}</div>
                        )}
                        {override && (
                          <div className="activity-override">
                            Changed after the agent's restriction
                            {after
                              ? ` (${label(after.action).toLowerCase()}, ${simDay(after.simDate)})`
                              : ''}
                          </div>
                        )}
                        {why && <blockquote className="activity-why">“{why}”</blockquote>}
                        {e.policyRef && e.policyRef !== 'manual' && (
                          <span className="tag">{e.policyRef}</span>
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

function Actor({ e }: { e: AuditEvent }) {
  if (isPerson(e)) return <span className="actor person">{e.actorName || label(e.actorRole)}</span>;
  if (e.actorRole === 'AGENT') return <span className="actor agent">Agent</span>;
  return <span className="actor system">System</span>;
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
      return `Tier ${e.fromState} → ${e.toState}`;
    case 'PROPOSE':
      return 'Proposed for approval';
    case 'AUTO_APPLIED':
      return e.actorRole === 'AGENT' || !PEOPLE.includes(e.actorRole)
        ? 'Applied under policy'
        : 'Applied';
    case 'TRANSITION':
      return label(e.toState ?? '');
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
    default:
      return label(e.action);
  }
}
