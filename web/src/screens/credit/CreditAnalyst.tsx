import { useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { SlidingPill } from '../../components/SlidingPill';
import { tierName, useCreditBook, useCreditPolicy, type ScoredClient } from '../../lib/credit';
import { simDay } from '../../lib/format';
import { useClock } from '../../lib/session';
import { tables } from '../../module_bindings';
import { Exploits } from './Exploits';
import { Learning } from './Learning';
import { Portfolio } from './Portfolio';
import { TiersPolicy } from './TiersPolicy';

const TABS = {
  portfolio: 'Portfolio',
  tiers: 'Tiers & policy',
  exploits: 'Exploits',
  learning: 'Learning',
} as const;

type Tab = keyof typeof TABS;

/**
 * Seat 1, the credit analyst: scores every client on value and reliability, sorts them
 * into tiers, spots clients gaming the terms, and learns from what people decide.
 * The controller's changes to the tier guidelines apply at once.
 */
export function CreditAnalyst() {
  const policy = useCreditPolicy();
  const book = useCreditBook(policy.weights, policy.tiers);
  const clock = useClock();
  const [audit] = useTable(tables.auditEvent);
  const [tab, setTab] = useState<Tab>('portfolio');
  const flagged = new Set(book.flatMap((c) => c.patterns)).size;

  return (
    <section className="ca">
      <div className="screen-head">
        <div>
          <div className="eyebrow">Quinn and Rowan · Credit and exploits</div>
          <h2>Credit Analyst</h2>
          <p className="muted">
            Scores every client on value and reliability, sorts them into tiers, and flags clients
            gaming the terms. A change you make to the guidelines applies at once and is kept in the audit log.
          </p>
        </div>
        <div className="row">
          <span className="ca-chip mono">
            Model v{policy.modelVersion || 1} · Policy v{policy.tiersVersion || 1} · scored{' '}
            {simDay(clock?.simDate)}
          </span>
          <button
            className="btn"
            onClick={() => exportBook(book, policy.tiers)}
            disabled={!book.length}
          >
            Export credit book
          </button>
        </div>
      </div>

      <div className="filters" role="toolbar" aria-label="Credit analyst sections">
        <div className="segmented">
          <SlidingPill active={tab} className="dark" />
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button
              key={t}
              className={`filter ${tab === t ? 'active' : ''}`}
              data-active={tab === t}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
            >
              {TABS[t]}
              {t === 'portfolio' && <span className="count">{book.length}</span>}
              {t === 'exploits' && flagged > 0 && <span className="count">{flagged}</span>}
              {t === 'tiers' && policy.drafts.some((d) => d.policyId === 'credit-tiers') && (
                <span className="count">draft</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {!book.length ? (
        <div className="empty">Scoring clients…</div>
      ) : tab === 'portfolio' ? (
        <Portfolio book={book} policy={policy} audit={audit} />
      ) : tab === 'tiers' ? (
        <TiersPolicy book={book} policy={policy} />
      ) : tab === 'exploits' ? (
        <Exploits book={book} />
      ) : (
        <Learning book={book} policy={policy} audit={audit} />
      )}
    </section>
  );
}

/** The scored book as a CSV the browser saves. */
function exportBook(book: ScoredClient[], tiers: Parameters<typeof tierName>[1]) {
  const head = [
    'client_id',
    'name',
    'segment',
    'tier',
    'tier_name',
    'suggested_tier',
    'score',
    'value',
    'reliability',
    'ar_usd',
    'expected_loss_usd',
    'patterns',
  ];
  const rows = book.map((c) => [
    c.client.id,
    c.client.name,
    c.client.segment,
    c.client.tier,
    tierName(c.client.tier, tiers),
    c.suggestedTier,
    c.score,
    c.value,
    c.reliability,
    (Number(c.arCents) / 100).toFixed(2),
    (Number(c.expectedLossCents) / 100).toFixed(2),
    c.patterns.join(' '),
  ]);
  const csv = [head, ...rows]
    .map((r) =>
      r
        .map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)))
        .join(','),
    )
    .join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'credit-book.csv';
  a.click();
  URL.revokeObjectURL(url);
}
