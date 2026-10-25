import { useMemo, useState, type CSSProperties } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { Badge, StateBadge } from '../components/Badge';
import { SlidingPill } from '../components/SlidingPill';
import { CollapseButton, useSlideClose } from '../components/useSlideClose';
import { LeverChips, stateAfter, useLevers } from '../components/LeverChips';
import { label, money, parseJson, percent } from '../lib/format';
import { REASONS, reasonFor, waitingReason } from '../lib/autonomy';
import { useSession } from '../lib/session';
import { reducers, tables } from '../module_bindings';
import type {
  AuditEvent,
  ContractClause,
  Decision,
  Policy,
  WorkItem,
} from '../module_bindings/types';

const OPEN = ['PROPOSED', 'NEEDS_INFO'];

/** Pills: everything waiting, one per reason a person is asked, and what people already decided. */
const FILTERS = {
  waiting: { label: 'Waiting', reason: undefined, open: true },
  top: { label: 'Top clients', reason: 'top', open: true },
  offboarding: { label: 'Offboarding', reason: 'offboarding', open: true },
  exploit: { label: 'Exploit fixes', reason: 'exploit', open: true },
  decided: { label: 'Decided', reason: undefined, open: false },
} as const;

type FilterKey = keyof typeof FILTERS;

/**
 * The agent acts on its own; this is the short list it asks a person about:
 * restricting a top client, offboarding, and exploit fixes to the tier guidelines.
 */
export function WorkQueue() {
  const [items] = useTable(tables.workItem);
  const [clients] = useTable(tables.client);
  const levers = useLevers();
  // Subscribed here, not in the drawer, so the drawer opens with its data already loaded.
  const [policies] = useTable(tables.policy);
  const [clauses] = useTable(tables.contractClause);
  const [decisions] = useTable(tables.decision);
  const [audit] = useTable(tables.auditEvent);
  const [filter, setFilter] = useState<FilterKey>('waiting');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<bigint>();

  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  // Only items a person was asked about; everything the agent did alone is in the Audit log.
  const asked = useMemo(
    () =>
      items
        .filter((w) => !w.autoApplied && reasonFor(w, clientById.get(w.clientId)))
        .sort((a, b) => (a.id < b.id ? 1 : -1)),
    [items, clientById],
  );
  const test = (key: FilterKey) => (w: WorkItem) => {
    const f = FILTERS[key];
    if (f.open !== OPEN.includes(w.state)) return false;
    return !f.reason || reasonFor(w, clientById.get(w.clientId)) === f.reason;
  };
  const shown = asked.filter((w) => {
    if (!test(filter)(w)) return false;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const c = clientById.get(w.clientId);
    const text = [w.title, c?.name, c?.id, c?.segment].join(' ').toLowerCase();
    return words.every((x) => text.includes(x));
  });
  const open = items.find((w) => w.id === openId);
  const openClient = open ? clientById.get(open.clientId) : undefined;

  return (
    <section>
      <div className="screen-head">
        <div>
          <h2>Approvals</h2>
          <p className="muted">
            The agent acts on its own. It only asks you to restrict a top client, offboard a client,
            or change the tier guidelines to fix an exploit.
          </p>
        </div>
      </div>

      <div className="filters" role="toolbar" aria-label="Filter approvals">
        <input
          type="search"
          className="search"
          placeholder="Search clients or requests…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search approvals"
        />
        <div className="segmented">
          <SlidingPill active={filter} className="dark" />
          {(Object.keys(FILTERS) as FilterKey[]).map((key) => (
            <button
              key={key}
              className={`filter ${filter === key ? 'active' : ''}`}
              data-active={filter === key}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {FILTERS[key].label}
              <span className="count">{asked.filter(test(key)).length}</span>
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          {query
            ? `Nothing matches “${query}”.`
            : filter === 'decided'
              ? 'Nothing decided yet.'
              : 'Nothing waiting. The agent handled everything else on its own; see the Audit log.'}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table clients">
            <thead>
              <tr>
                <th>Client</th>
                <th>Tier</th>
                <th>What the agent wants</th>
                <th>Why it's asking</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((w, i) => {
                const c = clientById.get(w.clientId);
                const r = reasonFor(w, c);
                return (
                  <tr
                    key={String(w.id)}
                    style={{ '--row': Math.min(i, 14) } as CSSProperties}
                    className={w.id === openId ? 'selected' : ''}
                    onClick={() => setOpenId(w.id)}
                  >
                    <td>
                      <div className="title">{c?.name ?? noClient(w.kind)}</div>
                      <div className="eyebrow">
                        {c ? (
                          <>
                            {c.segment} · <span className="mono">{c.id}</span>
                          </>
                        ) : w.kind === 'POLICY_DRAFT' ? (
                          'Guideline change'
                        ) : (
                          label(w.kind)
                        )}
                      </div>
                    </td>
                    <td className="muted">{c ? `T${c.tier}` : '—'}</td>
                    <td className="ask">
                      {w.title}
                      <div className="eyebrow">
                        Agent {Math.round(w.confidence * 100)}% sure · {label(w.kind)}
                      </div>
                    </td>
                    <td>
                      {r && (
                        <>
                          <Badge tone={r === 'exploit' ? 'bad' : r === 'top' ? 'info' : 'warn'}>
                            {REASONS[r].label}
                          </Badge>
                          <div className="eyebrow">{REASONS[r].note}</div>
                        </>
                      )}
                    </td>
                    <td className="num">
                      {w.amountCents ? money(w.amountCents) : <span className="muted">—</span>}
                    </td>
                    <td>
                      <StateBadge state={w.state} />
                    </td>
                    <td>
                      <button
                        className="btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenId(w.id);
                        }}
                      >
                        {OPEN.includes(w.state) ? 'Review' : 'View'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <Drawer
          item={open}
          clientName={openClient?.name}
          waiting={waitingReason(open, openClient)}
          levers={levers}
          data={{ policies, clauses, decisions, audit }}
          onClose={() => setOpenId(undefined)}
        />
      )}
    </section>
  );
}

/** Items without a client: a change to a whole tier's guidelines, or platform-wide. */
function noClient(kind: string) {
  if (kind === 'POLICY_DRAFT') return 'All clients on the tier';
  return kind.startsWith('UNIDENTIFIED') ? 'Unknown payer' : 'Platform-wide';
}

function Confidence({ value }: { value: number }) {
  const tone = value >= 0.9 ? 'good' : value >= 0.6 ? 'warn' : 'bad';
  return (
    <span className={`confidence ${tone}`}>
      <span className="track">
        <span className="bar" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="mono">{percent(value)}</span>
    </span>
  );
}

type Proposal = {
  lever?: string;
  step?: string;
  invoiceIds?: string[];
  invoices?: string[];
  plan?: { allocations?: { invoiceId: string; amountCents: string }[]; basis?: string };
};

function Drawer({
  item,
  clientName,
  waiting,
  levers,
  data: { policies, clauses, decisions, audit },
  onClose,
}: {
  item: WorkItem;
  clientName?: string;
  waiting?: string;
  levers: ReturnType<typeof useLevers>;
  data: {
    policies: readonly Policy[];
    clauses: readonly ContractClause[];
    decisions: readonly Decision[];
    audit: readonly AuditEvent[];
  };
  onClose: () => void;
}) {
  const { leaving, close } = useSlideClose(onClose);
  const session = useSession();
  const transition = useReducer(reducers.transitionWorkItem);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState<bigint>();

  const proposal = parseJson<Proposal>(item.proposalJson, {});
  const policy = policies.find((p) => p.key === item.policyRef || p.policyId === item.policyRef);
  const cited = item.clausesCited.map((ref) => ({
    ref,
    clause: clauses.find((c) => c.clientId === item.clientId && c.clause === ref),
  }));
  const history = audit
    .filter((e) => e.workItemId === item.id)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const itemDecisions = decisions.filter((d) => d.workItemId === item.id);
  // Denied transitions don't throw; the reducer writes an audit row with the reason instead.
  const denied =
    sentAt !== undefined
      ? history.find((e) => e.id > sentAt && e.action === 'TRANSITION' && !e.allowed)
      : undefined;

  const before = levers.states[item.clientId] ?? {};
  const changesLever = (item.kind === 'RESTRICTION' || item.kind === 'RESTORE') && proposal.lever;
  const after = changesLever
    ? { ...before, [proposal.lever!]: stateAfter(item.kind, proposal.step) }
    : undefined;
  const allocations = proposal.plan?.allocations ?? [];
  const isOpen = OPEN.includes(item.state);

  async function decide(toState: 'APPROVED' | 'REJECTED' | 'NEEDS_INFO') {
    setBusy(true);
    setSentAt(history.at(-1)?.id ?? 0n);
    try {
      await transition({ workItemId: item.id, toState, note });
      setNote('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className={`drawer ${leaving ? 'leaving' : ''}`} aria-label={`Work item ${item.id}`}>
      <div className="drawer-head">
        <CollapseButton onClick={close} />
        <div className="drawer-title">
          <div className="eyebrow">
            #{String(item.id)} · {label(item.kind)} ·{' '}
            {clientName ?? (item.clientId || noClient(item.kind))}
          </div>
          <h3>{item.title}</h3>
          <div className="row">
            <StateBadge state={item.state} />
            {item.autoApplied && <Badge tone="info">auto-applied under policy</Badge>}
            {item.amountCents > 0n && <Badge>{money(item.amountCents)}</Badge>}
            <Confidence value={item.confidence} />
          </div>
        </div>
      </div>

      <div className="drawer-body">
        {waiting && <p className="notice info waiting">{waiting}</p>}
        <h4>Why</h4>
        <p>{item.reasoning || <span className="muted">No reasoning given.</span>}</p>
        {proposal.plan?.basis && proposal.plan.basis !== item.reasoning && (
          <p className="muted">{proposal.plan.basis}</p>
        )}

        {after && (
          <>
            <h4>Access before → after</h4>
            <div className="before-after">
              <LeverChips states={before} details={levers.details[item.clientId]} />
              <span className="arrow">→</span>
              <LeverChips states={after} changed={proposal.lever} />
              <span className="muted">
                {label(proposal.lever!)}
                {proposal.step ? `: ${label(proposal.step).toLowerCase()}` : ': restored'}
              </span>
            </div>
          </>
        )}

        {allocations.length > 0 && (
          <>
            <h4>Applied to</h4>
            <ul className="list">
              {allocations.map((a) => (
                <li key={a.invoiceId}>
                  <span>{a.invoiceId}</span>
                  <span>{money(BigInt(a.amountCents))}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {(proposal.invoiceIds ?? proposal.invoices)?.length ? (
          <>
            <h4>Invoices</h4>
            <p>{(proposal.invoiceIds ?? proposal.invoices)!.join(', ')}</p>
          </>
        ) : null}

        <h4>Policy and contract</h4>
        <ul className="list">
          <li>
            <span>
              <strong>{item.policyRef || '—'}</strong> {policy?.title}
            </span>
            {policy && (
              <Badge tone={policy.status === 'active' ? 'good' : 'neutral'}>{policy.status}</Badge>
            )}
          </li>
          {cited.map(({ ref, clause }) => (
            <li key={ref} className="stack">
              <strong>§{ref}</strong>
              {clause && <span className="muted">{clause.text}</span>}
            </li>
          ))}
        </ul>

        {isOpen && !item.autoApplied && (
          <>
            <h4>Decision</h4>
            {!session.canApprove && (
              <p className="notice warn">
                Read-only: decisions need the controller token (VITE_STDB_CONTROLLER_TOKEN in .env).
              </p>
            )}
            <textarea
              placeholder="Note for the audit log (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              disabled={!session.canApprove}
            />
            <div className="row">
              <button
                className="btn primary"
                disabled={busy || !session.canApprove}
                onClick={() => decide('APPROVED')}
              >
                Approve
              </button>
              <button
                className="btn"
                disabled={busy || !session.canApprove}
                onClick={() => decide('NEEDS_INFO')}
              >
                Ask for info
              </button>
              <button
                className="btn danger"
                disabled={busy || !session.canApprove}
                onClick={() => decide('REJECTED')}
              >
                Reject
              </button>
            </div>
            {denied && <p className="notice bad">Refused: {denied.detail}</p>}
          </>
        )}

        {itemDecisions.length > 0 && (
          <>
            <h4>Decisions</h4>
            <ul className="list">
              {itemDecisions.map((d) => (
                <li key={String(d.id)} className="stack">
                  <span>
                    <strong>{label(d.decision)}</strong> by {d.role.toLowerCase()}
                  </span>
                  {d.note && <span className="muted">{d.note}</span>}
                </li>
              ))}
            </ul>
          </>
        )}

        <h4>History</h4>
        <ol className="timeline">
          {history.map((e) => (
            <li key={String(e.id)} className={e.allowed ? '' : 'denied'}>
              <span className="eyebrow">
                {e.simDate} · {e.actorName || e.actorRole.toLowerCase()}
              </span>
              <span>
                {label(e.action)}
                {e.fromState && e.toState ? ` ${label(e.fromState)} → ${label(e.toState)}` : ''}
                {!e.allowed && ' · refused'}
              </span>
              {e.detail && <span className="muted">{e.detail}</span>}
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}
