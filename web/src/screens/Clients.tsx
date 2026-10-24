import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Badge } from '../components/Badge';
import { ClientPanel, type PanelMode } from '../components/ClientPanel';
import { SlidingPill } from '../components/SlidingPill';
import { shortDate, useClientRows, type ClientRow } from '../lib/clients';
import { money } from '../lib/format';

const FILTERS = {
  all: { label: 'All', test: () => true },
  overdue: { label: 'Overdue', test: (r: ClientRow) => r.overdueCents > 0n },
  approval: { label: 'Needs approval', test: (r: ClientRow) => r.waiting.length > 0 },
  restricted: {
    label: 'Restricted',
    test: (r: ClientRow) => r.levers.some((l) => l.state === 'limited' || l.state === 'off'),
  },
  top: { label: 'Tier 1–2', test: (r: ClientRow) => r.client.tier <= 2 },
  flagged: { label: 'Flagged', test: (r: ClientRow) => r.flagged },
} as const;

type FilterKey = keyof typeof FILTERS;

const SORTS = {
  client: (a: ClientRow, b: ClientRow) => a.client.name.localeCompare(b.client.name),
  tier: (a: ClientRow, b: ClientRow) => a.client.tier - b.client.tier,
  unpaid: (a: ClientRow, b: ClientRow) => Number(b.unpaidCents - a.unpaidCents),
  late: (a: ClientRow, b: ClientRow) =>
    b.daysPastDue - a.daysPastDue || Number(b.overdueCents - a.overdueCents),
} as const;

type SortKey = keyof typeof SORTS;

/** Home: every client, worst first, with what's happening and what happens next. */
export function Clients() {
  const rows = useClientRows();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortKey>('late');
  const [panel, setPanel] = useState<{ clientId: string; mode: PanelMode }>();
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    // Matches name, legal name, ID, segment or RM; every word must match somewhere.
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (r: ClientRow) => {
      const c = r.client;
      const text = [c.name, c.legalName, c.id, c.segment, c.relationshipManager]
        .join(' ')
        .toLowerCase();
      return words.every((w) => text.includes(w));
    };
    return rows.filter((r) => FILTERS[filter].test(r) && matches(r)).sort(SORTS[sort]);
  }, [rows, filter, sort, query]);
  const open = rows.find((r) => r.client.id === panel?.clientId);

  const header = (key: SortKey, text: string, className = '') => (
    <th className={className} aria-sort={sort === key ? 'descending' : undefined}>
      <button className={`sort ${sort === key ? 'active' : ''}`} onClick={() => setSort(key)}>
        {text}
        {sort === key && ' ↓'}
      </button>
    </th>
  );

  return (
    <section>
      <div className="screen-head">
        <div>
          <h2>Clients</h2>
          <p className="muted">Who owes what, what the desk is doing about it, and what's next.</p>
        </div>
      </div>

      <div className="filters" role="toolbar" aria-label="Filter clients">
        <input
          type="search"
          className="search"
          placeholder="Search clients, IDs, RMs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search clients"
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
              <span className="count">{rows.filter(FILTERS[key].test).length}</span>
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          {query ? `No clients match “${query}”.` : 'No clients match this filter.'}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table clients">
            <thead>
              <tr>
                {header('client', 'Client')}
                {header('tier', 'Tier')}
                {header('unpaid', 'Unpaid', 'num')}
                {header('late', 'Days late', 'num')}
                <th>Expected payment</th>
                <th>Status</th>
                <th>Access</th>
                <th>Next step</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr
                  key={r.client.id}
                  style={{ '--row': Math.min(i, 14) } as CSSProperties}
                  className={r.client.id === panel?.clientId ? 'selected' : ''}
                  onClick={() => setPanel({ clientId: r.client.id, mode: 'overview' })}
                >
                  <td>
                    <div className="title">
                      {r.client.name}
                      {r.client.strategic && <span className="star"> · Strategic</span>}
                    </div>
                    <div className="eyebrow">
                      {r.client.segment} · <span className="mono">{r.client.id}</span>
                    </div>
                  </td>
                  <td className="muted">T{r.client.tier}</td>
                  <td className="num">
                    {r.unpaidCents > 0n ? money(r.unpaidCents) : <span className="muted">—</span>}
                    {r.disputedCents > 0n && (
                      <div className="eyebrow">{money(r.disputedCents)} disputed</div>
                    )}
                  </td>
                  <td className={`num ${r.inDefault ? 'late' : ''}`}>
                    {r.daysPastDue > 0 ? `${r.daysPastDue}d` : <span className="muted">—</span>}
                    {r.daysPastDue > 0 && !r.inDefault && <div className="eyebrow">in grace</div>}
                  </td>
                  <td>
                    {!r.expected ? (
                      <span className="muted">—</span>
                    ) : 'prepay' in r.expected ? (
                      'Prepay only'
                    ) : (
                      <>
                        {shortDate(r.expected.on)}
                        <div className="eyebrow">{r.expected.source}</div>
                      </>
                    )}
                  </td>
                  <td>
                    <Badge tone={r.status.tone}>{r.status.label}</Badge>
                  </td>
                  <td>
                    <Access row={r} />
                  </td>
                  <td className="next">{r.next}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <RowMenu
                      name={r.client.name}
                      onPick={(mode) => setPanel({ clientId: r.client.id, mode })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && panel && (
        <ClientPanel
          row={open}
          mode={panel.mode}
          onMode={(mode) => setPanel({ ...panel, mode })}
          onClose={() => setPanel(undefined)}
        />
      )}
    </section>
  );
}

/** Only what's restricted gets colour; a client with everything on reads "Full access". */
function Access({ row }: { row: ClientRow }) {
  const changed = row.levers.filter((l) => l.state === 'limited' || l.state === 'off');
  if (!changed.length) return <span className="muted">Full access</span>;
  return (
    <span className="access">
      {changed.map((l) => (
        <span key={l.key} className={`access-tag ${l.state}`} title={l.detail}>
          {l.name} {l.state === 'off' ? 'off' : 'limited'}
        </span>
      ))}
    </span>
  );
}

/** Rendered into <body> at a fixed position, so no row or the table's scroll box can cover or clip it. */
function RowMenu({ name, onPick }: { name: string; onPick: (mode: PanelMode) => void }) {
  const [pos, setPos] = useState<{ top: number; right: number }>();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const open = pos !== undefined;

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(undefined);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !button.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // A fixed menu would drift from its row, so scrolling or resizing closes it.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    list.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = () => {
    if (open) return setPos(undefined);
    const r = button.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };
  const pick = (mode: PanelMode) => {
    setPos(undefined);
    onPick(mode);
  };

  return (
    <>
      <button
        ref={button}
        className="btn ghost icon"
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <div
            className="menu-list"
            role="menu"
            ref={list}
            style={{ top: pos.top, right: pos.right }}
          >
            <button role="menuitem" onClick={() => pick('access')}>
              Change access…
            </button>
            <button role="menuitem" onClick={() => pick('notes')}>
              Add note…
            </button>
            <button role="menuitem" onClick={() => pick('overview')}>
              Open client
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
