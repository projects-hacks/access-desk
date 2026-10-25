import { useMemo, useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { Badge } from '../../components/Badge';
import {
  RELIABILITY_DRIVERS,
  VERTICAL_TIERS,
  useCreditBook,
  type ScoredClient,
  type useCreditPolicy,
  type Weights,
} from '../../lib/credit';
import { label } from '../../lib/format';
import { daysBetween, shortDate } from '../../lib/clients';
import { useSession } from '../../lib/session';
import { reducers, tables } from '../../module_bindings';
import type { AuditEvent } from '../../module_bindings/types';
import { CreditDesk } from '../CreditDesk';

type Policy = ReturnType<typeof useCreditPolicy>;

const LOG_ACTIONS = new Set([
  'POLICY_SAVED',
  'POLICY_ACTIVATED',
  'POLICY_REJECTED',
  'POLICY_SUPERSEDED',
  'TIER_CHANGED',
  'STRATEGIC_SET',
  'PRECEDENT',
  'EXPLOIT_FLAGGED',
]);

const KIND: Record<string, string> = {
  POLICY_SAVED: 'Policy',
  POLICY_ACTIVATED: 'Policy',
  POLICY_REJECTED: 'Policy',
  POLICY_SUPERSEDED: 'Policy',
  TIER_CHANGED: 'Re-tier',
  STRATEGIC_SET: 'Precedent',
  PRECEDENT: 'Precedent',
  EXPLOIT_FLAGGED: 'Detector',
};

/** What the analyst read, what it found, the policies it started from, and what it has learned since. */
export function Learning({
  book,
  policy,
  audit,
}: {
  book: ScoredClient[];
  policy: Policy;
  audit: readonly AuditEvent[];
}) {
  const [invoices] = useTable(tables.invoice);
  const [cash] = useTable(tables.cashMovement);
  const [contracts] = useTable(tables.contract);
  const [clauses] = useTable(tables.contractClause);
  const [applications] = useTable(tables.paymentApplication);
  const [holdings] = useTable(tables.custodyHolding);
  const [precedents] = useTable(tables.precedent);

  const read = [
    { k: 'IN', name: 'Billing', sub: 'Invoices, credits, disputes', n: invoices.length },
    { k: 'BK', name: 'Bank feed', sub: 'Wires, ACH, USDC, remitter names', n: cash.length },
    { k: 'PA', name: 'Platform admin', sub: 'Accounts, permissions, positions', n: book.length },
    { k: 'CT', name: 'Client contracts', sub: 'Grace, cure, set-off clauses', n: contracts.length },
  ];

  const findings = useMemo(() => {
    const lates = invoices
      .filter((i) => i.paidOn && i.paidOn > i.dueOn)
      .map((i) => daysBetween(i.dueOn, i.paidOn!))
      .sort((a, b) => a - b);
    const medianLate = lates[Math.floor(lates.length / 2)] ?? 0;
    const bySegment = (seg: string) => {
      const cs = book.filter((c) => c.client.segment === seg);
      return cs.length ? Math.round(cs.reduce((s, c) => s + c.reliability, 0) / cs.length) : 0;
    };
    const shortPayers = new Set(
      applications
        .filter((a) => a.method === 'short_fee')
        .map((a) => invoices.find((i) => i.id === a.invoiceId)?.clientId)
        .filter(Boolean),
    ).size;
    const setOff = clauses.filter((c) => c.kind === 'set_off' && c.allowed).length;
    const covered = book.filter((c) => {
      const usd =
        holdings.find((h) => h.clientId === c.client.id && h.asset === 'USD')?.valueCents ?? 0n;
      return c.arCents > 0n && usd >= c.arCents;
    }).length;
    return [
      `When clients pay late, the median is ${medianLate} days after the due date.`,
      `Market makers average reliability ${bySegment('Market maker')}; hedge funds ${bySegment('Hedge fund')}; fintechs ${bySegment('Fintech')}.`,
      `${shortPayers} client${shortPayers === 1 ? ' short-pays' : 's short-pay'} by an intermediary wire fee of $50 or less.`,
      `${setOff} contracts allow set-off from custody; ${covered} clients hold enough USD in custody to cover what they owe.`,
    ];
  }, [invoices, book, applications, clauses, holdings]);

  const log = useMemo(() => {
    const fromAudit = audit
      .filter((e) => LOG_ACTIONS.has(e.action) && e.allowed)
      .map((e) => ({
        id: `a${e.id}`,
        at: e.simDate,
        kind: KIND[e.action] ?? 'Event',
        title: e.detail || label(e.action),
        sub: `${label(e.action)} · ${e.actorName || e.actorRole.toLowerCase()}`,
        order: Number(e.id),
      }));
    const fromPrecedents = precedents
      .filter((p) => p.source === 'live' && p.policyRef !== 'console')
      .map((p) => ({
        id: `p${p.id}`,
        at: p.decidedOn,
        kind: 'Precedent',
        title: `${p.decision}: ${p.situation}`,
        sub: p.overrideReason || p.proposed,
        order: 0,
      }));
    return [...fromAudit, ...fromPrecedents]
      .sort((a, b) => (a.at === b.at ? b.order - a.order : a.at < b.at ? 1 : -1))
      .slice(0, 30);
  }, [audit, precedents]);

  const tiersActive = policy.policies.find(
    (p) => p.policyId === 'credit-tiers' && p.status === 'active',
  );
  const modelActive = policy.policies.find(
    (p) => p.policyId === 'credit-model' && p.status === 'active',
  );

  return (
    <>
      <div className="ca-grid">
        <div className="ca-card">
          <span className="eyebrow">Day 0 · onboarding</span>
          <h3>What it read</h3>
          <ul className="ca-sources">
            {read.map((r) => (
              <li key={r.k}>
                <span className="ca-src">{r.k}</span>
                <span>
                  <strong>{r.name}</strong>
                  <span className="muted">{r.sub}</span>
                </span>
                <span className="mono">{r.n.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <h4>What it found</h4>
          <ol className="ca-findings">
            {findings.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ol>
          <h4>Starting policies it drafted</h4>
          <ul className="list">
            <li>
              <span>
                <strong>Five percentile tiers</strong>
                <span className="eyebrow">
                  {' '}
                  · top{' '}
                  {VERTICAL_TIERS.slice(0, 4)
                    .map((t) => `${t.topPct}%`)
                    .join(' / ')}{' '}
                  / rest
                </span>
              </span>
              <Badge tone={tiersActive ? 'good' : 'neutral'}>
                {tiersActive ? `active v${tiersActive.version}` : 'vertical default'}
              </Badge>
            </li>
            <li>
              <span>
                <strong>Five-rung restriction ladder</strong>
                <span className="eyebrow"> · trading kept open while hedges are live</span>
              </span>
              <Badge tone="good">active</Badge>
            </li>
            <li>
              <span>
                <strong>Reliability model</strong>
                <span className="eyebrow"> · five weighted signals</span>
              </span>
              <Badge tone={modelActive ? 'good' : 'neutral'}>
                {modelActive ? `active v${modelActive.version}` : 'vertical default'}
              </Badge>
            </li>
            <li>
              <span>
                <strong>When a person approves</strong>
                <span className="eyebrow">
                  {' '}
                  · restricting top clients, offboarding, exploit fixes
                </span>
              </span>
              <Badge tone="good">active</Badge>
            </li>
          </ul>
        </div>

        <div>
          <WeightsCard book={book} policy={policy} />
          <div className="ca-card">
            <h3>Learning log</h3>
            <p className="muted">
              Every human decision becomes a precedent the next re-score respects.
            </p>
            {log.length === 0 ? (
              <p className="muted">
                Nothing yet. Tier changes, policy decisions and dismissals show up here.
              </p>
            ) : (
              <ol className="ca-log">
                {log.map((l) => (
                  <li key={l.id}>
                    <span className="mono eyebrow">{shortDate(l.at)}</span>
                    <span className="ca-logkind">{l.kind}</span>
                    <span>
                      <strong>{l.title}</strong>
                      <span className="muted">{l.sub}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>

      <details className="ca-card ca-agent">
        <summary>
          <strong>Agent decision trace & backtest</strong>
          <span className="muted">
            {' '}
            · how Quinn scored and decided each client, and how accurate it was
          </span>
        </summary>
        <CreditDesk />
      </details>
    </>
  );
}

/** The reliability weights in force, and a change the evidence suggests. */
function WeightsCard({ book, policy }: { book: ScoredClient[]; policy: Policy }) {
  const session = useSession();
  const propose = useReducer(reducers.proposeGuidelineChange);
  const w = policy.weights;
  const resets = book.filter((c) => c.patterns.includes('aging_reset')).length;
  const disputes = book.filter((c) => c.patterns.includes('dispute_to_delay')).length;

  // Evidence-driven proposal: weigh what the exploits slipped past more heavily.
  const proposal = useMemo((): { weights: Weights; why: string } | undefined => {
    const r = { ...w.reliability };
    if (resets && r.credibility >= 0.1) {
      r.partials = round(r.partials + 0.05);
      r.credibility = round(r.credibility - 0.05);
      return {
        weights: { ...w, reliability: r },
        why: `${resets} client${resets === 1 ? '' : 's'} reset aging with partial payments while the current weights still scored them as reliable.`,
      };
    }
    if (disputes && r.onTime >= 0.1) {
      r.credibility = round(r.credibility + 0.05);
      r.onTime = round(r.onTime - 0.05);
      return {
        weights: { ...w, reliability: r },
        why: `${disputes} client${disputes === 1 ? '' : 's'} delay payment through disputes that on-time scoring doesn't catch.`,
      };
    }
    return undefined;
  }, [w, resets, disputes]);

  const next = useCreditBook(proposal?.weights ?? w, policy.tiers);
  const moves = proposal
    ? next.filter(
        (n) => book.find((b) => b.client.id === n.client.id)?.suggestedTier !== n.suggestedTier,
      ).length
    : 0;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'good' | 'bad'; text: string }>();

  async function submit() {
    if (!proposal) return;
    setBusy(true);
    setResult(undefined);
    try {
      await propose({
        policyId: 'credit-model',
        title: `Reliability weights: ${RELIABILITY_DRIVERS.filter(
          (d) => proposal.weights.reliability[d.key] !== w.reliability[d.key],
        )
          .map(
            (d) =>
              `${d.name.toLowerCase()} ${pct(w.reliability[d.key])}→${pct(proposal.weights.reliability[d.key])}`,
          )
          .join(', ')}`,
        ruleJson: JSON.stringify({ weights: proposal.weights }),
        reasoning: proposal.why,
        clientId: '',
      });
      setResult({
        tone: 'good',
        text: 'Applied. Every client is re-scored on the new weights.',
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setResult({
        tone: 'bad',
        text: /no such reducer|not found|unknown reducer/i.test(m)
          ? 'Not live yet: Rajeev needs to publish this database function.'
          : m,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ca-card">
      <div className="row spread">
        <h3>Reliability model · v{policy.modelVersion || 1}</h3>
        {proposal && <Badge tone="info">Proposed change</Badge>}
      </div>
      <p className="muted">
        The weights the analyst uses today{proposal ? ', and a change it wants to make' : ''}.
      </p>
      <ul className="ca-weights">
        {RELIABILITY_DRIVERS.map((d) => {
          const now = w.reliability[d.key];
          const then = proposal?.weights.reliability[d.key] ?? now;
          return (
            <li key={d.key}>
              <span>{d.name}</span>
              <span className="ca-wbar">
                <span style={{ width: `${now * 200}%` }} />
                {then !== now && (
                  <span
                    className={`ca-wghost ${then > now ? 'up' : 'down'}`}
                    style={{ width: `${then * 200}%` }}
                  />
                )}
              </span>
              <span className="mono">
                {pct(now)}
                {then !== now && <strong className="ca-wto"> → {pct(then)}</strong>}
              </span>
            </li>
          );
        })}
      </ul>
      {proposal ? (
        <div className="ca-fix">
          <strong>Why</strong>
          <p className="muted">
            {proposal.why} Re-scoring with these weights moves {moves} client
            {moves === 1 ? '' : 's'} to a different suggested tier.
          </p>
          <div className="row">
            <button
              className="btn primary"
              disabled={busy || session.role !== 'CONTROLLER'}
              onClick={submit}
            >
              Apply change
            </button>
          </div>
          {result && <p className={`notice ${result.tone}`}>{result.text}</p>}
        </div>
      ) : (
        <p className="ca-foot">
          No change suggested: nothing in the evidence points against the current weights.
        </p>
      )}
      <p className="ca-foot">
        Value weights: 12-month revenue {pct(w.value.revenue)} · monthly bill {pct(w.value.monthly)}{' '}
        · product breadth {pct(w.value.breadth)}
      </p>
    </div>
  );
}

const round = (x: number) => Math.round(x * 100) / 100;
const pct = (x: number) => `${Math.round(x * 100)}%`;
