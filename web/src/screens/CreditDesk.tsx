import { useMemo, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { config } from '../lib/config';
import { reducers, tables } from '../module_bindings';

/**
 * Seat 1 (credit analyst) output: scores, exploit flags and the CREDIT_REVIEW /
 * POLICY_DRAFT / EXPLOIT_FLAG queue a controller decides. Claude decides each
 * company within guardrails (the rules are the fallback); each card shows who
 * decided, Claude's choice next to the rules' baseline and the guardrails that
 * applied. Approving here runs as the console's controller identity, so a tier
 * change lands in `client.tier` and a policy draft becomes active at once.
 */

const OPEN = new Set(['PROPOSED', 'NEEDS_INFO']);
const KINDS = new Set(['CREDIT_REVIEW', 'POLICY_DRAFT', 'EXPLOIT_FLAG']);
const KIND_LABEL: Record<string, string> = { CREDIT_REVIEW: 'Credit review', POLICY_DRAFT: 'Company policy', EXPLOIT_FLAG: 'Exploit flag' };
const AUDITED = new Set([
  'TIER_CHANGED', 'EXPLOIT_FLAGGED', 'CREDIT_SCORED', 'TRANSITION', 'PROPOSE',
  'POLICY_SAVED', 'POLICY_ACTIVATED', 'POLICY_SUPERSEDED', 'POLICY_REJECTED', 'POLICY_OUTCOME',
]);

const usd = (cents: bigint) => `$${(Number(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const parse = <T,>(json: string): T | undefined => {
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
};

interface ReviewProposal {
  action: 'tier_change' | 'review';
  from_tier: number;
  to_tier: number;
  breakdown?: Record<string, number>;
  flags?: string[];
}
interface Evidence { invoice_id: string; due_on: string; paid_on: string | null; dpd: number; note: string }
interface Term { lever: string; value: number | null; at_renewal: boolean }
interface Criterion { metric: string; target: number; pattern: string | null; window_months: number }
interface Choice {
  action: 'stay' | 'tier_change' | 'review';
  to_tier: number;
  policy: { kind: 'existing' | 'company_draft'; policy_id: string; title: string; terms: Term[]; success_criteria: Criterion[] } | null;
  reasons: string[];
  cited_invoice_ids: string[];
  confidence: number;
}
/** What the agent records on every CREDIT_REVIEW and POLICY_DRAFT about how it decided. */
interface DecisionMeta {
  decided_by?: 'claude' | 'rules';
  why?: string;
  baseline?: { action: string; to_tier: number; policy_ref: string; confidence: number };
  choice?: Choice | null;
  guardrails?: string[];
  rejected_attempts?: { violations: string[]; error: string }[];
  policy_key?: string;
  rule?: { terms?: Term[]; success_criteria?: Criterion[] };
}

const actionText = (action: string | undefined, from: number, to: number | undefined) =>
  action === 'tier_change' ? `tier ${from} → ${to}` : action === 'review' ? 'review' : `keep tier ${from}`;
const termText = (t: Term) =>
  `${t.lever.replace(/_/g, ' ')}${t.value !== null ? ` ${t.value} days` : ''}${t.at_renewal ? ' at renewal' : ''}`;
const criterionText = (k: Criterion) =>
  k.metric === 'pattern_not_firing'
    ? `${k.pattern} stops firing (${k.window_months} mo)`
    : `${k.metric.replace(/_/g, ' ')} ${k.metric === 'share_paid_within_grace' ? '≥' : '≤'} ${k.target} (${k.window_months} mo)`;

export function CreditDesk() {
  const conn = useSpacetimeDB();
  const [clients] = useTable(tables.client);
  const [profiles] = useTable(tables.creditProfile);
  const [flags] = useTable(tables.exploitFlag);
  const [items] = useTable(tables.workItem);
  const [audit] = useTable(tables.auditEvent);
  const [clock] = useTable(tables.clock);
  const [policies] = useTable(tables.policy);
  const [precedents] = useTable(tables.precedent);
  const transition = useReducer(reducers.transitionWorkItem);
  const [selected, setSelected] = useState<string>();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();

  const profileOf = useMemo(() => new Map(profiles.map((p) => [p.clientId, p])), [profiles]);
  const flagsOf = useMemo(() => {
    const m = new Map<string, typeof flags[number][]>();
    for (const f of flags) m.set(f.clientId, [...(m.get(f.clientId) ?? []), f]);
    return m;
  }, [flags]);
  const credit = useMemo(
    () => items.filter((w) => KINDS.has(w.kind)).sort((a, b) => Number(a.id - b.id)),
    [items],
  );
  const open = credit.filter((w) => OPEN.has(w.state));
  const decided = credit.filter((w) => !OPEN.has(w.state)).reverse();
  const openReviewOf = (clientId: string) => open.find((w) => w.clientId === clientId && w.kind === 'CREDIT_REVIEW');
  const sorted = [...clients].sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
  const nameOf = (id: string) => clients.find((c) => c.id === id)?.name ?? id;
  const creditIds = new Set(credit.map((w) => w.id));
  // Work-item events only for credit items; score, flag and tier events always.
  const trail = audit
    .filter((a) => AUDITED.has(a.action) && (!a.workItemId || creditIds.has(a.workItemId) || a.action === 'TIER_CHANGED'))
    .sort((a, b) => Number(b.id - a.id))
    .slice(0, 25);

  const decide = async (id: bigint, toState: 'APPROVED' | 'REJECTED') => {
    setError(undefined);
    try {
      await transition({ workItemId: id, toState, note: notes[String(id)] ?? '' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const client = clients.find((c) => c.id === selected);
  return (
    <section className="credit">
      <header className="credit-head">
        <div>
          <h2>Credit analyst</h2>
          <p className="muted">
            {config.stdbDatabase} · sim date {clock[0]?.simDate ?? '…'} ·{' '}
            <span className={conn.isActive ? 'ok' : 'bad'}>{conn.isActive ? 'connected' : 'connecting…'}</span>
            {!config.stdbToken && <span className="bad"> · read-only (no controller token)</span>}
          </p>
        </div>
        <div className="stats">
          <Stat label="Profiles" value={profiles.length} />
          <Stat label="Exploit flags" value={flags.filter((f) => f.status !== 'cleared').length} />
          <Stat label="Open reviews" value={open.filter((w) => w.kind === 'CREDIT_REVIEW').length} />
          <Stat label="Decided" value={decided.length} />
        </div>
      </header>
      {error && <p className="banner bad">{error}</p>}

      <div className="credit-grid">
        <div>
          <h3>Waiting on a controller ({open.length})</h3>
          {!open.length && <p className="muted">Nothing open. Run one agent cycle to score the book.</p>}
          {open.map((w) => {
            const key = String(w.id);
            const tier = clients.find((c) => c.id === w.clientId)?.tier ?? 0;
            return (
              <article key={key} className={`card ${w.kind === 'EXPLOIT_FLAG' ? 'flag' : w.kind === 'POLICY_DRAFT' ? 'policy' : ''}`} onClick={() => setSelected(w.clientId)}>
                <div className="card-top">
                  <span className="kind">{KIND_LABEL[w.kind] ?? w.kind}</span>
                  <span className="muted">#{key} · {w.policyRef} · confidence {w.confidence.toFixed(2)} · exposure {usd(w.amountCents)}</span>
                </div>
                <h4>{w.title}</h4>
                <p className="reasoning">{w.reasoning}</p>
                {w.kind !== 'EXPLOIT_FLAG' && <Decision meta={parse<DecisionMeta & { from_tier?: number }>(w.proposalJson)} tier={tier} />}
                <div className="actions" onClick={(e) => e.stopPropagation()}>
                  <input
                    placeholder="Note (required context for a rejection)"
                    value={notes[key] ?? ''}
                    onChange={(e) => setNotes({ ...notes, [key]: e.target.value })}
                  />
                  <button className="approve" disabled={!config.stdbToken} onClick={() => decide(w.id, 'APPROVED')}>Approve</button>
                  <button className="reject" disabled={!config.stdbToken} onClick={() => decide(w.id, 'REJECTED')}>Reject</button>
                </div>
              </article>
            );
          })}

          {!!decided.length && <h3>Decided</h3>}
          {decided.map((w) => (
            <div key={String(w.id)} className="decided" onClick={() => setSelected(w.clientId)}>
              <span className={`pill ${w.state.toLowerCase()}`}>{w.state}</span> {w.title}
            </div>
          ))}
        </div>

        <div>
          <h3>Clients</h3>
          <table>
            <thead>
              <tr><th>Client</th><th>Tier</th><th>Reliability</th><th>Value</th><th>Coverage</th><th>Settles</th><th>Flags</th></tr>
            </thead>
            <tbody>
              {sorted.map((c) => {
                const p = profileOf.get(c.id);
                const review = openReviewOf(c.id);
                const proposal = review && parse<ReviewProposal>(review.proposalJson);
                return (
                  <tr key={c.id} className={c.id === selected ? 'selected' : ''} onClick={() => setSelected(c.id)}>
                    <td>{c.name}{c.strategic && <span className="pill strategic">strategic</span>}</td>
                    <td className="tier">
                      {c.tier}
                      {proposal?.action === 'tier_change' && <span className={proposal.to_tier < c.tier ? 'up' : 'down'}> → {proposal.to_tier}</span>}
                      {proposal?.action === 'review' && <span className="down"> review</span>}
                    </td>
                    <td><Bar value={p?.reliabilityScore} /></td>
                    <td><Bar value={p?.valueScore} /></td>
                    <td className="num">{p ? `${p.coverageRatio.toFixed(2)}×` : '–'}</td>
                    <td className="num">{p?.expectedSettleOn ?? '–'}</td>
                    <td>{(flagsOf.get(c.id) ?? []).map((f) => <span key={f.id} className={`pill ${f.status}`}>{f.pattern}</span>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {client && (
            <div className="detail">
              <h3>{client.name} <span className="muted">{client.id} · {client.segment} · tier {client.tier}</span></h3>
              <p>{profileOf.get(client.id)?.coverageDetail ?? 'Not scored yet.'}</p>
              {(() => {
                const own = policies.filter((p) => p.policyId.endsWith(`:${client.id}`)).sort((a, b) => a.key.localeCompare(b.key));
                if (!own.length) return null;
                return (
                  <div className="evidence">
                    <h4>Company policies</h4>
                    <table>
                      <thead><tr><th>Version</th><th>Status</th><th>Title</th><th>Effective</th><th>Outcome</th></tr></thead>
                      <tbody>
                        {own.map((p) => {
                          const rule = parse<{ effective_on?: string; work_item_id?: number }>(p.ruleJson);
                          const outcome = rule?.work_item_id ? precedents.find((x) => x.id === `PRC-L${rule.work_item_id}`)?.outcome : '';
                          return (
                            <tr key={p.key}>
                              <td>{p.key}</td><td><span className={`pill ${p.status}`}>{p.status}</span></td><td>{p.title}</td>
                              <td>{rule?.effective_on ?? '–'}</td><td>{outcome || '–'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
              {(() => {
                const review = credit.filter((w) => w.clientId === client.id && w.kind === 'CREDIT_REVIEW').at(-1);
                const b = review && parse<ReviewProposal>(review.proposalJson)?.breakdown;
                if (!b) return null;
                return (
                  <dl className="breakdown">
                    {(['lateness', 'frequency', 'severity', 'pieces', 'disputes'] as const).map((k) => (
                      <div key={k}><dt>{k}</dt><dd>−{(b[k] ?? 0).toFixed(1)}</dd></div>
                    ))}
                    <div><dt>raw</dt><dd>{b.raw?.toFixed(1)}</dd></div>
                    <div><dt>months</dt><dd>{b.periods}</dd></div>
                  </dl>
                );
              })()}
              {(flagsOf.get(client.id) ?? []).map((f) => {
                const evidence = parse<Evidence[]>(f.evidenceJson) ?? [];
                return (
                  <div key={f.id} className="evidence">
                    <h4>{f.pattern} <span className="muted">{f.status} · {f.months} months · score {f.score.toFixed(2)}</span></h4>
                    <p className="muted">Fix: {f.proposedFix}</p>
                    <table>
                      <thead><tr><th>Invoice</th><th>Due</th><th>Paid</th><th>DPD</th><th>Note</th></tr></thead>
                      <tbody>
                        {evidence.map((e, i) => (
                          <tr key={`${e.invoice_id}-${i}`}><td>{e.invoice_id}</td><td>{e.due_on}</td><td>{e.paid_on ?? '–'}</td><td className="num">{e.dpd}</td><td>{e.note}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}

          <h3>Audit trail</h3>
          <ul className="audit">
            {trail.map((a) => (
              <li key={String(a.id)} className={a.allowed ? '' : 'denied'}>
                <span className="muted">{a.simDate}</span> <b>{a.actorRole}</b> {a.action}{' '}
                {a.fromState || a.toState ? `${a.fromState || '·'} → ${a.toState}` : ''} <span className="muted">{nameOf(a.clientId)} · {a.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Who decided, Claude's choice next to the rules' baseline, and the guardrails that applied. */
function Decision({ meta, tier }: { meta: (DecisionMeta & { from_tier?: number }) | undefined; tier: number }) {
  if (!meta?.decided_by) return null;
  const from = meta.from_tier ?? tier;
  const choice = meta.choice;
  const terms = choice?.policy?.terms ?? meta.rule?.terms ?? [];
  const criteria = choice?.policy?.success_criteria ?? meta.rule?.success_criteria ?? [];
  const rejected = meta.rejected_attempts ?? [];
  return (
    <div className="decision">
      <div>
        <span className={`pill by-${meta.decided_by}`}>{meta.decided_by === 'claude' ? 'Decided by Claude' : 'Decided by rules'}</span>
        {choice && <span>Claude: <b>{actionText(choice.action, from, choice.to_tier)}</b>{choice.policy ? ` · ${choice.policy.kind === 'company_draft' ? 'new' : 'cites'} ${choice.policy.policy_id}` : ''}</span>}
        {meta.baseline && <span className="muted"> · rules: {actionText(meta.baseline.action, from, meta.baseline.to_tier)}{meta.baseline.policy_ref ? ` (${meta.baseline.policy_ref})` : ''}</span>}
      </div>
      {meta.why && <p className="muted">{meta.why}</p>}
      {!!terms.length && <p>Terms: {terms.map(termText).join('; ')}</p>}
      {!!criteria.length && <p>Success: {criteria.map(criterionText).join('; ')}</p>}
      {!!meta.guardrails?.length && (
        <details onClick={(e) => e.stopPropagation()}>
          <summary>Guardrails ({meta.guardrails.length}){rejected.length ? ` · ${rejected.length} rejected attempt${rejected.length > 1 ? 's' : ''}` : ''}</summary>
          <ul>{meta.guardrails.map((g) => <li key={g}>{g}</li>)}</ul>
          {rejected.map((a, i) => (
            <ul key={i} className="violations">
              {a.error && <li>{a.error}</li>}
              {a.violations.map((v) => <li key={v}>{v}</li>)}
            </ul>
          ))}
        </details>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="stat"><b>{value}</b><span>{label}</span></div>;
}

function Bar({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="muted">–</span>;
  const tone = value >= 85 ? 'good' : value >= 70 ? 'mid' : value >= 55 ? 'warn' : 'poor';
  return (
    <span className="bar">
      <span className={`fill ${tone}`} style={{ width: `${value}%` }} />
      <span className="num">{value}</span>
    </span>
  );
}
