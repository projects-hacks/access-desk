import { useMemo, useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { Badge } from '../../components/Badge';
import {
  LADDER,
  PATTERNS,
  tierName,
  type Driver,
  type ScoredClient,
  type useCreditPolicy,
} from '../../lib/credit';
import { money } from '../../lib/format';
import { useSession } from '../../lib/session';
import { reducers } from '../../module_bindings';
import type { AuditEvent } from '../../module_bindings/types';
import { Meter, Scatter, Sparkline, TIER_COLORS } from './charts';

type Policy = ReturnType<typeof useCreditPolicy>;

const SORTS = {
  score: (a: ScoredClient, b: ScoredClient) => b.score - a.score,
  name: (a: ScoredClient, b: ScoredClient) => a.client.name.localeCompare(b.client.name),
  tier: (a: ScoredClient, b: ScoredClient) => a.client.tier - b.client.tier || b.score - a.score,
  value: (a: ScoredClient, b: ScoredClient) => b.value - a.value,
  reliability: (a: ScoredClient, b: ScoredClient) => b.reliability - a.reliability,
  ar: (a: ScoredClient, b: ScoredClient) => Number(b.arCents - a.arCents),
} as const;
type SortKey = keyof typeof SORTS;

const PAGE = 12;

export function Portfolio({
  book,
  policy,
  audit,
}: {
  book: ScoredClient[];
  policy: Policy;
  audit: readonly AuditEvent[];
}) {
  const [selectedId, setSelectedId] = useState(book[0]?.client.id ?? '');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('score');
  const [page, setPage] = useState(0);

  const selected = book.find((c) => c.client.id === selectedId) ?? book[0]!;
  const ar = book.reduce((s, c) => s + c.arCents, 0n);
  const loss = book.reduce((s, c) => s + c.expectedLossCents, 0n);
  const median =
    [...book].sort((a, b) => a.reliability - b.reliability)[Math.floor(book.length / 2)]
      ?.reliability ?? 0;

  // Tier moves in the last 6 months: tier changes that took effect.
  const moves = useMemo(() => {
    const changes = audit.filter((e) => e.action === 'TIER_CHANGED' && e.allowed);
    const up = changes.filter((e) => Number(e.toState) < Number(e.fromState)).length;
    return { changes, up, down: changes.length - up };
  }, [audit]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return book
      .filter((c) => {
        const text = [
          c.client.name,
          c.client.id,
          c.client.segment,
          ...c.patterns.map((p) => PATTERNS[p].name),
        ]
          .join(' ')
          .toLowerCase();
        return words.every((w) => text.includes(w));
      })
      .sort(SORTS[sort]);
  }, [book, query, sort]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const pageRows = shown.slice(page * PAGE, page * PAGE + PAGE);

  const header = (key: SortKey, text: string, className = '') => (
    <th className={className} aria-sort={sort === key ? 'descending' : undefined}>
      <button className={`sort ${sort === key ? 'active' : ''}`} onClick={() => setSort(key)}>
        {text}
        {sort === key && ' ↓'}
      </button>
    </th>
  );

  return (
    <>
      <div className="ca-strip">
        <Stat
          label="Clients scored"
          value={String(book.length)}
          sub={`${book.filter((c) => c.fromAgent).length} by the agent, the rest from history`}
        />
        <Stat
          label="AR outstanding"
          value={money(ar, true)}
          sub={`${book.filter((c) => c.arCents > 0n).length} clients with open balances`}
        />
        <Stat
          label="Expected loss"
          value={money(loss, true)}
          sub="AR × (1 − reliability) × 50% LGD"
        />
        <Stat
          label="Median reliability"
          value={String(median)}
          sub={`weights v${policy.modelVersion || 1}`}
        />
        <Stat
          label="Tier moves · 6 mo"
          value={`${moves.up}↑ ${moves.down}↓`}
          sub="changes that took effect"
        />
      </div>

      <div className="ca-grid">
        <div className="ca-card">
          <div className="ca-card-head">
            <div>
              <h3>Value × reliability</h3>
              <p className="muted">All {book.length} clients. Click a dot to open the client.</p>
            </div>
            <Legend tiers={policy.tiers} />
          </div>
          <Scatter
            dots={book.map((c) => ({
              id: c.client.id,
              x: c.value,
              y: c.reliability,
              tier: c.client.tier,
              label: c.client.name,
            }))}
            selected={selected.client.id}
            onSelect={setSelectedId}
          />
        </div>

        <div className="ca-card">
          <h3>Tier mix</h3>
          <p className="muted">Where clients sit today, and their open balances.</p>
          <TierMix book={book} policy={policy} />
          <h4>Movers</h4>
          <Movers book={book} policy={policy} audit={moves.changes} onSelect={setSelectedId} />
        </div>
      </div>

      <div className="ca-grid ca-grid-book">
        <div className="ca-card ca-flush">
          <div className="ca-card-head ca-pad">
            <h3>Credit book</h3>
            <input
              type="search"
              className="search"
              placeholder="Search clients, segments, patterns…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              aria-label="Search the credit book"
            />
          </div>
          <div className="table-wrap ca-table">
            <table className="table clients cards">
              <thead>
                <tr>
                  {header('name', 'Client')}
                  {header('tier', 'Tier')}
                  {header('score', 'Score', 'num')}
                  {header('value', 'Value', 'num')}
                  {header('reliability', 'Reliability')}
                  <th>6 mo</th>
                  {header('ar', 'AR', 'num')}
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((c) => (
                  <tr
                    key={c.client.id}
                    className={c.client.id === selected.client.id ? 'selected' : ''}
                    onClick={() => setSelectedId(c.client.id)}
                  >
                    <td className="cell-main">
                      <div className="title">
                        {c.client.name}
                        {c.client.strategic && <span className="star"> · Strategic</span>}
                      </div>
                      <div className="eyebrow">{c.client.segment}</div>
                    </td>
                    <td data-label="Tier">
                      <TierTag tier={c.client.tier} />
                      {c.suggestedTier !== c.client.tier && (
                        <div className="eyebrow">model: T{c.suggestedTier}</div>
                      )}
                    </td>
                    <td className="num mono" data-label="Score">{c.score}</td>
                    <td className="num mono" data-label="Value">{c.value}</td>
                    <td data-label="Reliability">
                      <span className="ca-rel">
                        <Meter value={c.reliability} />
                        <span className="mono">{c.reliability}</span>
                      </span>
                    </td>
                    <td data-label="6 mo">
                      <Sparkline values={c.trend} />
                    </td>
                    <td className="num mono" data-label="AR">{c.arCents > 0n ? money(c.arCents) : <span className="muted">-</span>}</td>
                    <td data-label="Flags">
                      {c.patterns.length ? (
                        <Badge tone="bad">
                          {c.patterns.length === 1
                            ? PATTERNS[c.patterns[0]!].name
                            : `${c.patterns.length} patterns`}
                        </Badge>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ca-pager">
            <span className="eyebrow">
              {shown.length
                ? `${page * PAGE + 1}–${Math.min(shown.length, (page + 1) * PAGE)} of ${shown.length}`
                : 'No clients match'}
            </span>
            <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button className="btn" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        </div>

        <ClientDetail key={selected.client.id} c={selected} policy={policy} />
      </div>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="ca-stat">
      <span className="eyebrow">{label}</span>
      <strong className="mono">{value}</strong>
      <span className="ca-sub">{sub}</span>
    </div>
  );
}

function Legend({ tiers }: { tiers: Policy['tiers'] }) {
  return (
    <span className="ca-legend">
      {tiers.map((t) => (
        <span key={t.tier}>
          <i style={{ background: TIER_COLORS[t.tier] }} />T{t.tier}
        </span>
      ))}
    </span>
  );
}

export function TierTag({ tier }: { tier: number }) {
  return <span className={`ca-tier t${tier}`}>T{tier}</span>;
}

function TierMix({ book, policy }: { book: ScoredClient[]; policy: Policy }) {
  const max = Math.max(
    1,
    ...policy.tiers.map((t) => book.filter((c) => c.client.tier === t.tier).length),
  );
  return (
    <ul className="ca-mix">
      {policy.tiers.map((t) => {
        const inTier = book.filter((c) => c.client.tier === t.tier);
        return (
          <li key={t.tier}>
            <TierTag tier={t.tier} />
            <span className="ca-mix-name">{t.name}</span>
            <span className="ca-mix-bar">
              <span
                style={{
                  width: `${(inTier.length / max) * 100}%`,
                  background: TIER_COLORS[t.tier],
                }}
              />
            </span>
            <span className="mono ca-mix-n">{inTier.length}</span>
            <span className="mono ca-mix-ar">
              {money(
                inTier.reduce((s, c) => s + c.arCents, 0n),
                true,
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Movers({
  book,
  policy,
  audit,
  onSelect,
}: {
  book: ScoredClient[];
  policy: Policy;
  audit: AuditEvent[];
  onSelect: (id: string) => void;
}) {
  // Tier changes that happened, newest first, then clients the model would move.
  const happened = [...audit].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 4);
  const suggested = book
    .filter((c) => c.suggestedTier !== c.client.tier && !c.client.strategic)
    .slice(0, 5 - Math.min(4, happened.length));
  if (!happened.length && !suggested.length) return <p className="muted">No tier moves yet.</p>;
  const nameOf = (id: string) => book.find((c) => c.client.id === id)?.client.name ?? id;
  return (
    <ul className="ca-movers">
      {happened.map((e) => (
        <li key={String(e.id)} onClick={() => e.clientId && onSelect(e.clientId)}>
          <span>
            <strong>{nameOf(e.clientId)}</strong>
            <span className="eyebrow">{e.detail || 'Tier changed'}</span>
          </span>
          <span className="ca-move">
            <TierTag tier={Number(e.fromState)} /> → <TierTag tier={Number(e.toState)} />
          </span>
        </li>
      ))}
      {suggested.map((c) => (
        <li key={c.client.id} onClick={() => onSelect(c.client.id)}>
          <span>
            <strong>{c.client.name}</strong>
            <span className="eyebrow">
              Model suggests {tierName(c.suggestedTier, policy.tiers)} · reliability {c.reliability}
            </span>
          </span>
          <span className="ca-move">
            <TierTag tier={c.client.tier} /> ⇢ <TierTag tier={c.suggestedTier} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Drivers({ title, drivers, score }: { title: string; drivers: Driver[]; score: number }) {
  return (
    <>
      <h4 className="row spread">
        <span>{title}</span>
        <span className="mono">{score}</span>
      </h4>
      <ul className="ca-drivers">
        {drivers.map((d) => (
          <li key={d.key}>
            <span>{d.name}</span>
            <Meter value={d.value * 100} />
            <span className="mono muted">{Math.round(d.weight * 100)}%</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The selected client: why it scored what it did, its tier's rules, and the two human levers. */
function ClientDetail({ c, policy }: { c: ScoredClient; policy: Policy }) {
  const session = useSession();
  const setStrategic = useReducer(reducers.setStrategic);
  const changeTier = useReducer(reducers.proposeTierChange);
  const rule = policy.tiers.find((t) => t.tier === c.client.tier);
  const [tier, setTier] = useState(c.client.tier);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'good' | 'bad'; text: string }>();
  const canAct = session.role === 'CONTROLLER' || session.role === 'ADMIN';

  async function run(what: string, call: () => Promise<void>) {
    setBusy(true);
    setResult(undefined);
    try {
      await call();
      setResult({ tone: 'good', text: `${what}: done. It's logged as a precedent.` });
      setReason('');
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setResult({
        tone: 'bad',
        text: /no such reducer|not found|unknown reducer/i.test(m)
          ? `${what}: not live yet, Rajeev needs to publish this database function`
          : `${what}: ${m}`,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="ca-card ca-detail">
      <div className="eyebrow">
        {c.client.segment} · <span className="mono">{c.client.id}</span>
        {c.fromAgent ? ' · scored by the agent' : ' · scored from history'}
      </div>
      <h3>
        {c.client.name} {c.client.strategic && <Badge tone="info">Strategic</Badge>}
      </h3>
      <div className="ca-tiles">
        <div>
          <span className="eyebrow">Score</span>
          <strong className="mono">{c.score}</strong>
        </div>
        <div>
          <span className="eyebrow">Value</span>
          <strong className="mono">{c.value}</strong>
        </div>
        <div>
          <span className="eyebrow">Reliability</span>
          <strong className="mono">{c.reliability}</strong>
        </div>
      </div>

      <Drivers title="Value drivers" drivers={c.valueDrivers} score={c.value} />
      <Drivers title="Reliability drivers" drivers={c.reliabilityDrivers} score={c.reliability} />

      <h4 className="row spread">
        <span>Reliability, last 6 months</span>
        <Sparkline values={c.trend} width={110} height={26} />
      </h4>

      <h4>From its tier</h4>
      <ul className="list">
        <li>
          <span>Tier</span>
          <span>
            <TierTag tier={c.client.tier} /> {rule?.name}
          </span>
        </li>
        <li>
          <span>Grace days</span>
          <span className="mono">{rule?.graceDays ?? '-'}</span>
        </li>
        <li>
          <span>Agent may go up to</span>
          <span>{rule ? LADDER[rule.ceiling] : '-'}</span>
        </li>
        <li>
          <span>Model suggests</span>
          <span>
            <TierTag tier={c.suggestedTier} /> {tierName(c.suggestedTier, policy.tiers)}
          </span>
        </li>
      </ul>

      <h4>Override</h4>
      {!canAct && <p className="notice warn">Read-only: these need the controller token.</p>}
      <div className="ca-stepper">
        <span>Tier</span>
        <button
          className="btn icon"
          onClick={() => setTier(Math.max(1, tier - 1))}
          disabled={tier <= 1}
          aria-label="Higher tier"
        >
          −
        </button>
        <strong className="mono">T{tier}</strong>
        <button
          className="btn icon"
          onClick={() => setTier(Math.min(5, tier + 1))}
          disabled={tier >= 5}
          aria-label="Lower tier"
        >
          +
        </button>
        <span className="muted">{tierName(tier, policy.tiers)}</span>
      </div>
      <textarea
        rows={2}
        placeholder="Reasoning (logged as a precedent the next re-score respects)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="row">
        <button
          className="btn primary"
          disabled={busy || tier === c.client.tier || !reason.trim()}
          onClick={() =>
            run(`Tier ${c.client.tier} → ${tier}`, () =>
              changeTier({ clientId: c.client.id, toTier: tier, reasoning: reason.trim() }),
            )
          }
        >
          Change tier
        </button>
        <button
          className="btn"
          disabled={busy || !reason.trim()}
          onClick={() =>
            run(c.client.strategic ? 'Cleared strategic' : 'Marked strategic', () =>
              setStrategic({
                clientId: c.client.id,
                strategic: !c.client.strategic,
                reason: reason.trim(),
              }),
            )
          }
          title="Strategic clients are always handled by a person"
        >
          {c.client.strategic ? 'Clear strategic' : 'Mark as strategic'}
        </button>
      </div>
      {result && <p className={`notice ${result.tone}`}>{result.text}</p>}
      <p className="ca-foot">
        Strategic clients are treated as Tier 1: restricting them always needs a person.
      </p>
    </aside>
  );
}
