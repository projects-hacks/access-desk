import { useMemo, useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { shortDate, type ClientRow, type Lever } from '../lib/clients';
import { label, money } from '../lib/format';
import { useSession } from '../lib/session';
import { reducers, tables } from '../module_bindings';
import { Badge } from './Badge';
import { Select } from './Select';

export type PanelMode = 'overview' | 'access' | 'notes';

const MODES: { key: PanelMode; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'access', label: 'Change access' },
  { key: 'notes', label: 'Notes' },
];

/** Everything about one client, plus the two things a person can do here: change access, leave a note. */
export function ClientPanel({
  row,
  mode,
  onMode,
  onClose,
}: {
  row: ClientRow;
  mode: PanelMode;
  onMode: (mode: PanelMode) => void;
  onClose: () => void;
}) {
  const c = row.client;
  return (
    <aside className="drawer" aria-label={c.name}>
      <div className="drawer-head">
        <div>
          <div className="eyebrow">
            T{c.tier} · {c.segment} · <span className="mono">{c.id}</span>
            {c.relationshipManager && ` · RM ${c.relationshipManager}`}
          </div>
          <h3>{c.name}</h3>
          <div className="row">
            <Badge tone={row.status.tone}>{row.status.label}</Badge>
            {c.strategic && <Badge>Strategic</Badge>}
          </div>
        </div>
        <button className="btn ghost icon" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="drawer-tabs" role="tablist">
        {MODES.map((m) => (
          <button
            key={m.key}
            role="tab"
            aria-selected={mode === m.key}
            className={mode === m.key ? 'active' : ''}
            onClick={() => onMode(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="drawer-body">
        {mode === 'overview' && <Overview row={row} />}
        {mode === 'access' && <ChangeAccess row={row} />}
        {mode === 'notes' && <Notes row={row} />}
      </div>
    </aside>
  );
}

function Overview({ row }: { row: ClientRow }) {
  const [audit] = useTable(tables.auditEvent);
  const recent = useMemo(
    () =>
      audit
        .filter((e) => e.clientId === row.client.id)
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .slice(0, 8),
    [audit, row.client.id],
  );
  const open = row.invoices.filter((i) => i.status !== 'void' && i.paidCents < i.amountCents);
  const k = row.contract;

  return (
    <>
      <div className="stats">
        <Stat label="Unpaid" value={money(row.unpaidCents)} />
        <Stat label="Overdue" value={money(row.overdueCents)} />
        <Stat
          label="Days late"
          value={row.daysPastDue ? `${row.daysPastDue}d` : '—'}
          bad={row.inDefault}
        />
        <Stat
          label="Expected"
          value={
            !row.expected ? '—' : 'prepay' in row.expected ? 'Prepay' : shortDate(row.expected.on)
          }
        />
      </div>

      {row.waiting.length > 0 && (
        <>
          <h4>Waiting on a person</h4>
          <ul className="list">
            {row.waiting.map((w) => (
              <li key={String(w.id)} className="stack">
                <strong>{w.title}</strong>
                <span className="muted">{w.reasoning}</span>
                <span className="eyebrow">Review it in Approvals</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Access</h4>
      <ul className="list">
        {row.levers.map((l) => (
          <li key={l.key}>
            <span>{l.name}</span>
            <span className={`lever-state ${l.state}`}>{leverText(l)}</span>
          </li>
        ))}
      </ul>

      {k && (
        <>
          <h4>Contract</h4>
          <ul className="list">
            <li>
              <span>Payment terms</span>
              <span>Net {k.termsDays}</span>
            </li>
            <li>
              <span>Grace period</span>
              <span>{k.graceDays} days</span>
            </li>
            <li>
              <span>Cure period after notice</span>
              <span>{k.cureDays} days</span>
            </li>
            <li>
              <span>Cross-default</span>
              <span>{k.crossDefault ? 'Yes' : 'No'}</span>
            </li>
          </ul>
        </>
      )}

      <h4>Open invoices</h4>
      {open.length === 0 ? (
        <p className="muted">Nothing open.</p>
      ) : (
        <ul className="list">
          {open.map((i) => (
            <li key={i.id} className="stack">
              <span className="row spread">
                <strong>{i.label || i.id}</strong>
                <span className="mono">{money(i.amountCents - i.paidCents)}</span>
              </span>
              <span className="eyebrow">
                {i.id} · {i.product} · due {shortDate(i.dueOn)}
                {i.status === 'disputed' && ' · disputed'}
                {i.status === 'partially_paid' && ' · part paid'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4>Recent activity</h4>
      {recent.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ol className="timeline">
          {recent.map((e) => (
            <li key={String(e.id)} className={e.allowed ? '' : 'denied'}>
              <span className="eyebrow">
                {shortDate(e.simDate)} · {e.actorName || e.actorRole.toLowerCase()}
              </span>
              <span>{label(e.action)}</span>
              {e.detail && <span className="muted">{e.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="stat">
      <div className="eyebrow">{label}</div>
      <div className={`stat-value ${bad ? 'late' : ''}`}>{value}</div>
    </div>
  );
}

function leverText(l: Lever) {
  if (l.state === 'not_used') return 'Not in contract';
  if (l.state === 'active') return l.detail || 'On';
  return l.detail || (l.state === 'off' ? 'Off' : 'Limited');
}

const PERMISSION_GROUPS = [
  {
    lever: 'withdrawals',
    name: 'Custody',
    items: [
      { key: 'crypto_withdrawals', name: 'Crypto withdrawals' },
      { key: 'fiat_withdrawals', name: 'Fiat withdrawals' },
      { key: 'transfers', name: 'Transfers between portfolios' },
      { key: 'staking', name: 'Staking' },
    ],
  },
  {
    lever: 'trading',
    name: 'Trading',
    items: [
      { key: 'buy', name: 'Buy' },
      { key: 'sell', name: 'Sell' },
      { key: 'derivatives', name: 'Derivatives' },
      { key: 'otc', name: 'OTC desk' },
    ],
  },
  { lever: 'api', name: 'API', items: [{ key: 'api', name: 'API access' }] },
  { lever: 'financing', name: 'Borrowing', items: [{ key: 'borrowing', name: 'New borrowing' }] },
] as const;

/**
 * People change tier and permissions the same way agents do: each change is a proposal.
 * Routine ones apply at once; the rest wait in Approvals for a second controller.
 * The reasoning is what the agents read next time.
 */
function ChangeAccess({ row }: { row: ClientRow }) {
  const session = useSession();
  const [permissions] = useTable(tables.permission);
  const changePermissions = useReducer(reducers.proposePermissionChange);
  const changeTier = useReducer(reducers.proposeTierChange);

  const leverOf = (key: string) => row.levers.find((l) => l.key === key);
  const paid = PERMISSION_GROUPS.filter((g) => {
    const state = leverOf(g.lever)?.state;
    return state !== undefined && state !== 'not_used';
  });
  /** Saved value: the permission's own row, or else whether its lever is fully on. */
  const saved = (key: string, lever: string) =>
    permissions.find((p) => p.clientId === row.client.id && p.key === key)?.enabled ??
    leverOf(lever)?.state === 'active';

  const [tier, setTier] = useState(row.client.tier);
  const [edits, setEdits] = useState<Record<string, boolean>>({});
  const [reasoning, setReasoning] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ tone: 'good' | 'bad'; text: string }[]>([]);

  const toggle = (key: string, lever: string) => {
    const next = !(edits[key] ?? saved(key, lever));
    setEdits((e) => {
      const { [key]: _, ...rest } = e;
      return next === saved(key, lever) ? rest : { ...rest, [key]: next };
    });
  };
  const setGroup = (lever: string, on: boolean) => {
    const g = PERMISSION_GROUPS.find((x) => x.lever === lever)!;
    setEdits((e) => {
      const out = { ...e };
      for (const p of g.items) {
        if (on === saved(p.key, lever)) delete out[p.key];
        else out[p.key] = on;
      }
      return out;
    });
  };

  const changes = Object.keys(edits).length + (tier !== row.client.tier ? 1 : 0);
  const canApply = session.role === 'CONTROLLER' || session.role === 'ADMIN';

  async function apply() {
    setBusy(true);
    const out: typeof results = [];
    const why = reasoning.trim();
    const run = async (what: string, call: () => Promise<void>) => {
      try {
        await call();
        out.push({ tone: 'good', text: `${what}: done` });
      } catch (e) {
        out.push({ tone: 'bad', text: `${what}: ${explain(e)}` });
      }
    };
    if (tier !== row.client.tier) {
      await run(`Tier ${row.client.tier} → ${tier}`, () =>
        changeTier({ clientId: row.client.id, toTier: tier, reasoning: why }),
      );
    }
    const list = Object.entries(edits).map(([key, enabled]) => ({ key, enabled }));
    if (list.length) {
      await run(`${list.length} permission${list.length > 1 ? 's' : ''}`, () =>
        changePermissions({ clientId: row.client.id, changes: list, reasoning: why }),
      );
    }
    if (out.every((r) => r.tone === 'good')) {
      setEdits({});
      setReasoning('');
    }
    setResults(out);
    setBusy(false);
  }

  return (
    <>
      {!canApply && (
        <p className="notice warn">
          You're read-only, so Apply will be refused. Add the controller token
          (VITE_STDB_CONTROLLER_TOKEN) to .env to make changes.
        </p>
      )}

      <h4>Tier</h4>
      <Select
        label="Tier"
        value={tier}
        onChange={setTier}
        options={[1, 2, 3, 4, 5].map((t) => ({
          value: t,
          label: `Tier ${t}`,
          hint: t === row.client.tier ? 'current' : undefined,
        }))}
      />

      {/* Only products the client pays for; the others have nothing to switch. */}
      {paid.length === 0 && <p className="muted">This client has no products to switch.</p>}
      {paid.map((g) => {
        const lever = leverOf(g.lever)!;
        return (
          <div key={g.lever} className="perm-group">
            <h4 className="row spread">
              <span>
                {g.name}
                <span className={`lever-state ${lever.state}`}> · {leverText(lever)}</span>
              </span>
              {g.items.length > 1 && (
                <span className="group-actions">
                  <button className="link" onClick={() => setGroup(g.lever, true)}>
                    All on
                  </button>
                  <button className="link" onClick={() => setGroup(g.lever, false)}>
                    All off
                  </button>
                </span>
              )}
            </h4>
            <ul className="list toggles">
              {g.items.map((p) => {
                const on = edits[p.key] ?? saved(p.key, g.lever);
                const changed = p.key in edits;
                return (
                  <li key={p.key} className={changed ? 'changed' : ''}>
                    <span>
                      {p.name}
                      {changed && <span className="eyebrow"> · will turn {on ? 'on' : 'off'}</span>}
                    </span>
                    <button
                      role="switch"
                      aria-checked={on}
                      aria-label={p.name}
                      className={`switch ${on ? 'on' : ''}`}
                      onClick={() => toggle(p.key, g.lever)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      <h4>Reasoning</h4>
      <textarea
        rows={3}
        placeholder="e.g. RM confirmed the wire left their bank this morning; hold off until Friday."
        value={reasoning}
        onChange={(e) => setReasoning(e.target.value)}
      />
      <div className="row">
        <button
          className="btn primary"
          disabled={busy || !changes || !reasoning.trim()}
          onClick={apply}
        >
          {busy ? 'Applying…' : 'Apply'}
        </button>
        {changes > 0 && (
          <button
            className="btn ghost"
            onClick={() => {
              setEdits({});
              setTier(row.client.tier);
            }}
          >
            Undo changes
          </button>
        )}
        {changes > 0 && !reasoning.trim() && (
          <span className="eyebrow">Add reasoning to apply.</span>
        )}
      </div>
      {results.map((r, i) => (
        <p key={i} className={`notice ${r.tone}`}>
          {r.text}
        </p>
      ))}
      {results.some((r) => r.tone === 'good') && (
        <p className="eyebrow">
          Changes apply at once, except for top clients (Tier 1 or strategic) and offboarding (every
          permission off), which wait in Approvals for the other controller.
        </p>
      )}
    </>
  );
}

/** Database refusals in plain words; anything else is shown as the database said it. */
function explain(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/unregistered|requires one of/i.test(m))
    return 'refused: you are read-only (no controller token)';
  if (/no such reducer|reducer.*not found|unknown reducer/i.test(m))
    return 'not live yet: Rajeev needs to publish this database function';
  return m;
}

function Notes({ row }: { row: ClientRow }) {
  const session = useSession();
  const [notes] = useTable(tables.rmNote);
  const addNote = useReducer(reducers.addRmNote);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const own = notes
    .filter((n) => n.clientId === row.client.id)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  const canWrite = ['RELATIONSHIP_MANAGER', 'CONTROLLER', 'DEMO', 'ADMIN'].includes(
    session.role ?? '',
  );

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await addNote({
        clientId: row.client.id,
        author: session.name ?? '',
        text,
        workItemId: undefined,
      });
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted">
        Context for the team and the agents: what the RM heard, a promise, why you made a call.
      </p>
      {!canWrite && (
        <p className="notice warn">Read-only: adding notes needs a controller or RM token.</p>
      )}
      <textarea
        rows={3}
        placeholder="e.g. CFO says the March wire is stuck in compliance at their bank."
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!canWrite}
      />
      <button className="btn primary" disabled={busy || !canWrite || !text.trim()} onClick={save}>
        {busy ? 'Saving…' : 'Add note'}
      </button>
      {error && <p className="notice bad">{error}</p>}

      <h4>Notes</h4>
      {own.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        <ul className="list">
          {own.map((n) => (
            <li key={String(n.id)} className="stack">
              <span>{n.text}</span>
              <span className="eyebrow">
                {n.author || 'Someone'} · {n.at.toDate().toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
