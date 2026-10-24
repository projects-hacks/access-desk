import { useEffect, useMemo, useState } from 'react';
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
  baseline?: { action: string; to_tier: number; policy_ref: string; confidence: number; reasons?: string[] };
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
      <Accuracy />

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
              <Trace
                client={client}
                profile={profileOf.get(client.id)}
                flags={flagsOf.get(client.id) ?? []}
                item={credit.filter((w) => w.clientId === client.id && w.kind !== 'EXPLOIT_FLAG').at(-1)}
                review={credit.filter((w) => w.clientId === client.id && w.kind === 'CREDIT_REVIEW').at(-1)}
                note={(id) => audit.filter((a) => a.workItemId === id && a.action === 'TRANSITION' && a.allowed).at(-1)?.detail ?? ''}
              />
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


/**
 * How one client was decided, step by step: the evidence the scores were built
 * from, the patterns, the rules' answer, the guardrails, Claude's decision and
 * where it stands with the controller.
 */
function Trace({ client, profile, flags, item, review, note }: {
  client: { id: string; name: string; tier: number; strategic: boolean };
  profile: { reliabilityScore: number; valueScore: number; coverageRatio: number; coverageDetail: string; expectedSettleOn?: string } | undefined;
  flags: { id: string; pattern: string; status: string; score: number; months: number }[];
  item: { id: bigint; kind: string; state: string; proposalJson: string; title: string } | undefined;
  review: { proposalJson: string } | undefined;
  note: (id: bigint) => string;
}) {
  const meta = item ? parse<DecisionMeta & ReviewProposal>(item.proposalJson) : undefined;
  const b = (review && parse<ReviewProposal>(review.proposalJson)?.breakdown) ?? meta?.breakdown;
  const choice = meta?.choice;
  const from = meta?.from_tier ?? client.tier;
  const shrink = b ? `(${b.periods} × ${b.raw?.toFixed(1)} + 3 × 70) ÷ ${(b.periods ?? 0) + 3}` : '';
  return (
    <ol className="trace">
      <li>
        <h4>Evidence <span className="muted">deterministic, from the books</span></h4>
        {!profile && <p className="muted">Not scored yet.</p>}
        {profile && b && (
          <div className="waterfall">
            <span>100</span>
            {(['lateness', 'frequency', 'severity', 'pieces', 'disputes'] as const).map((k) => (
              <span key={k} className={(b[k] ?? 0) > 0 ? 'minus' : 'zero'}>− {(b[k] ?? 0).toFixed(1)} <small>{k}</small></span>
            ))}
            <span>= {b.raw?.toFixed(1)} <small>raw</small></span>
            <span>→ {shrink} = <b>{profile.reliabilityScore}</b> <small>reliability</small></span>
          </div>
        )}
        {profile && b?.size !== undefined && (
          <p>Value <b>{profile.valueScore}</b> = {b.size.toFixed(1)} <small>size of fees billed</small> + {b.breadth?.toFixed(1)} <small>{b.products} of 4 products</small></p>
        )}
        {profile && !b && <p>Reliability <b>{profile.reliabilityScore}</b> · value <b>{profile.valueScore}</b></p>}
        {profile && <p>Coverage <b>{profile.coverageRatio.toFixed(2)}×</b>: {profile.coverageDetail} Expected to settle {profile.expectedSettleOn ?? '—'}{b?.median_lag !== undefined ? ` (typical lag ${b.median_lag} days)` : ''}.</p>}
      </li>
      <li>
        <h4>Patterns <span className="muted">exploit detectors</span></h4>
        {flags.length
          ? <p>{flags.map((f) => <span key={f.id} className={`pill ${f.status}`}>{f.pattern} · {f.months} mo · {f.score.toFixed(2)}</span>)}</p>
          : <p className="muted">No pattern fired.</p>}
      </li>
      <li>
        <h4>Rules' answer <span className="muted">formula tier and guardrails</span></h4>
        {meta?.baseline
          ? <>
              <p><b>{actionText(meta.baseline.action, from, meta.baseline.to_tier)}</b>{meta.baseline.policy_ref ? ` (${meta.baseline.policy_ref})` : ''}</p>
              {!!meta.baseline.reasons?.length && <ul>{meta.baseline.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
            </>
          : <p><b>keep tier {client.tier}</b> <span className="muted">— nothing to decide, so Claude was not asked</span></p>}
      </li>
      <li>
        <h4>Guardrails <span className="muted">what any decision must respect</span></h4>
        {meta?.guardrails?.length ? <ul>{meta.guardrails.map((g) => <li key={g}>{g}</li>)}</ul> : <p className="muted">Not evaluated (no decision needed).</p>}
        {meta?.rejected_attempts?.map((a, i) => (
          <p key={i} className="bad">Rejected attempt {i + 1}: {[a.error, ...a.violations].filter(Boolean).join('; ')}</p>
        ))}
      </li>
      <li>
        <h4>Decision <span className={`pill by-${meta?.decided_by ?? 'rules'}`}>{meta?.decided_by === 'claude' ? 'Claude' : 'rules'}</span>{meta?.why && <span className="muted"> asked because: {meta.why}</span>}</h4>
        {choice
          ? <>
              <p><b>{actionText(choice.action, from, choice.to_tier)}</b>{choice.policy ? ` · ${choice.policy.kind === 'company_draft' ? 'new policy' : 'policy'} ${choice.policy.policy_id}: ${choice.policy.title}` : ''} · confidence {choice.confidence.toFixed(2)}</p>
              <ul>{choice.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              {!!choice.policy?.terms.length && <p>Terms: {choice.policy.terms.map(termText).join('; ')}</p>}
              {!!choice.policy?.success_criteria.length && <p>Success when: {choice.policy.success_criteria.map(criterionText).join('; ')}</p>}
              {!!choice.cited_invoice_ids.length && <p className="muted">Cites {choice.cited_invoice_ids.join(', ')}</p>}
            </>
          : <p>{meta?.baseline ? `Rules decided: ${actionText(meta.baseline.action, from, meta.baseline.to_tier)}.` : `No change for ${client.name}.`}</p>}
      </li>
      <li>
        <h4>Controller</h4>
        {item
          ? <p><span className={`pill ${item.state.toLowerCase()}`}>{item.state}</span> {item.title}{note(item.id) && item.state !== 'PROPOSED' ? <span className="muted"> · “{note(item.id)}”</span> : ''}</p>
          : <p className="muted">Nothing waiting.</p>}
      </li>
    </ol>
  );
}

interface Backtest {
  today: string;
  cutoffs: string[];
  settle: { n: number; mae_days: number; median_abs_days: number; within_3_days: number; bias_days: number; naive_mae_days: number };
  tiers: {
    n: number; held: number; upgrades: { n: number; held: number }; downgrades: { n: number; held: number };
    calibration: Record<string, { invoices: number; late_share: number }>;
  };
  exploits: { planted: string[]; caught: string[]; false_alarms: string[]; false_alarms_any_cutoff: string[]; first_seen: Record<string, string> };
}

/** The engine replayed at past month-ends against what clients actually did (credit/backtest.py). */
function Accuracy() {
  const [r, setR] = useState<Backtest>();
  useEffect(() => {
    fetch('/credit-backtest.json').then((x) => (x.ok ? x.json() : undefined)).then(setR).catch(() => setR(undefined));
  }, []);
  if (!r) return null;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <details className="accuracy" open>
      <summary>How accurate is it? <span className="muted">replayed at {r.cutoffs.length} month-ends ({r.cutoffs[0]} → {r.cutoffs.at(-1)}), judged on what clients did next</span></summary>
      <div className="acc-grid">
        <div>
          <h4>Pay-date prediction</h4>
          <p className="big">{r.settle.median_abs_days} <small>days median error</small></p>
          <p>mean {r.settle.mae_days} days vs <b>{r.settle.naive_mae_days}</b> for “pays on the due date” · {pct(r.settle.within_3_days)} within 3 days · runs {r.settle.bias_days > 0 ? `${r.settle.bias_days} days optimistic` : `${-r.settle.bias_days} days early`} · {r.settle.n} predictions</p>
        </div>
        <div>
          <h4>Does the tier mean anything?</h4>
          {Object.entries(r.tiers.calibration).map(([tier, c]) => (
            <div key={tier} className="calib">
              <span>tier {tier}</span>
              <span className="calib-bar"><span style={{ width: `${c.late_share * 100}%` }} /></span>
              <span className="num">{pct(c.late_share)} late</span>
            </div>
          ))}
          <p className="muted">share of invoices &gt;10 days late in the 90 days after</p>
        </div>
        <div>
          <h4>Did tier calls hold?</h4>
          <p className="big">{r.tiers.held}/{r.tiers.n}</p>
          <p>downgrades <b>{r.tiers.downgrades.held}/{r.tiers.downgrades.n}</b> · upgrades <b>{r.tiers.upgrades.held}/{r.tiers.upgrades.n}</b></p>
        </div>
        <div>
          <h4>Exploits</h4>
          <p className="big">{r.exploits.caught.length}/{r.exploits.planted.length} <small>caught</small></p>
          <p>{r.exploits.false_alarms.length} false alarms now{r.exploits.false_alarms_any_cutoff.length ? ` · earlier: ${r.exploits.false_alarms_any_cutoff.join(', ')}` : ''}</p>
        </div>
      </div>
    </details>
  );
}
