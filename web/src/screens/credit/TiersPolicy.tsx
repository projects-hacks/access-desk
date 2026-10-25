import { useMemo, useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { Badge } from '../../components/Badge';
import {
  LADDER,
  VERTICAL_TIERS,
  tierByPercentile,
  type ScoredClient,
  type TierRule,
  type useCreditPolicy,
} from '../../lib/credit';
import { money } from '../../lib/format';
import { useSession } from '../../lib/session';
import { reducers } from '../../module_bindings';
import { Histogram } from './charts';
import { TierTag } from './Portfolio';

type Policy = ReturnType<typeof useCreditPolicy>;
type Field = 'graceDays' | 'ceiling' | 'prepayAfter';

const same = (a: TierRule[], b: TierRule[]) => JSON.stringify(a) === JSON.stringify(b);

/** Where the tier lines sit and what each tier allows; editing makes a draft that waits in Approvals. */
export function TiersPolicy({ book, policy }: { book: ScoredClient[]; policy: Policy }) {
  const session = useSession();
  const propose = useReducer(reducers.proposeGuidelineChange);
  const [draft, setDraft] = useState<TierRule[]>(() => policy.tiers.map((t) => ({ ...t })));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'good' | 'bad'; text: string }>();
  const pending = policy.drafts.filter((d) => d.policyId === 'credit-tiers');

  const scores = book.map((c) => c.score);
  const draftTier = useMemo(() => tierByPercentile(scores, draft), [scores, draft]);
  const activeTier = useMemo(() => tierByPercentile(scores, policy.tiers), [scores, policy.tiers]);
  const changed = !same(draft, policy.tiers);
  const moved = book.filter(
    (c) => !c.client.strategic && draftTier(c.score) !== activeTier(c.score),
  );

  const setCutoff = (i: number, pct: number) =>
    setDraft((d) => {
      const next = d.map((t) => ({ ...t }));
      // Cutoffs stay in order: each tier's top % sits between its neighbours'.
      const lo = i > 0 ? next[i - 1]!.topPct + 1 : 1;
      const hi = next[i + 1]!.topPct - 1;
      next[i]!.topPct = Math.max(lo, Math.min(hi, pct));
      return next;
    });
  const step = (tier: number, field: Field, by: number) =>
    setDraft((d) =>
      d.map((t) => {
        if (t.tier !== tier) return t;
        const max = field === 'ceiling' ? LADDER.length - 1 : field === 'graceDays' ? 90 : 6;
        return { ...t, [field]: Math.max(0, Math.min(max, t[field] + by)) };
      }),
    );

  async function submit() {
    setBusy(true);
    setResult(undefined);
    try {
      await propose({
        policyId: 'credit-tiers',
        title: `Tier guidelines: ${summarize(policy.tiers, draft)}`,
        ruleJson: JSON.stringify({ tiers: draft }),
        reasoning: reason.trim(),
        clientId: '',
      });
      setResult({
        tone: 'good',
        text: 'Submitted. It waits in Approvals for the other controller.',
      });
      setReason('');
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
    <>
      <div className="ca-grid">
        <div className="ca-card">
          <h3>Score distribution</h3>
          <p className="muted">
            Drag a cutoff to re-tier clients live. Percentiles are of all {book.length} clients by
            score.
          </p>
          <Histogram scores={scores} tierOf={draftTier} />
          <div className="ca-cutoffs">
            {draft.slice(0, 4).map((t, i) => (
              <label key={t.tier}>
                <span className="row spread">
                  <span>
                    <TierTag tier={t.tier} /> {t.name}
                  </span>
                  <span className="mono">top {t.topPct}%</span>
                </span>
                <input
                  type="range"
                  min={1}
                  max={99}
                  value={t.topPct}
                  onChange={(e) => setCutoff(i, Number(e.target.value))}
                  aria-label={`Tier ${t.tier} cutoff, top percent`}
                />
              </label>
            ))}
          </div>
          <p className="ca-foot">Everyone below Tier 4 is Tier 5 · {draft[4]?.name}.</p>
        </div>

        <div className="ca-card">
          <h3>Tiers under this draft</h3>
          <ul className="ca-tiercards">
            {draft.map((t) => {
              const now = book.filter(
                (c) => (c.client.strategic ? 1 : draftTier(c.score)) === t.tier,
              );
              const before = book.filter(
                (c) => (c.client.strategic ? 1 : activeTier(c.score)) === t.tier,
              ).length;
              const diff = now.length - before;
              return (
                <li key={t.tier}>
                  <TierTag tier={t.tier} />
                  <span>
                    <strong>{t.name}</strong>
                    <span className="eyebrow">
                      {money(
                        now.reduce((s, c) => s + c.arCents, 0n),
                        true,
                      )}{' '}
                      AR
                    </span>
                  </span>
                  <strong className="mono">{now.length}</strong>
                  <span className={`ca-diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}`}>
                    {diff === 0 ? 'no change' : `${diff > 0 ? '+' : ''}${diff}`}
                  </span>
                </li>
              );
            })}
          </ul>
          <h4>Impact of this draft</h4>
          {moved.length ? (
            <p>
              {moved.length} client{moved.length === 1 ? '' : 's'} would move:{' '}
              <span className="muted">
                {moved
                  .slice(0, 6)
                  .map((c) => `${c.client.name} T${activeTier(c.score)}→T${draftTier(c.score)}`)
                  .join(', ')}
                {moved.length > 6 ? '…' : ''}
              </span>
            </p>
          ) : (
            <p className="muted">No clients move. Change a cutoff or a rule to see who moves.</p>
          )}
        </div>
      </div>

      <div className="ca-card ca-flush">
        <div className="ca-card-head ca-pad">
          <div>
            <h3>Rules per tier</h3>
            <p className="muted">
              Starts from what works in institutional crypto; <span className="ca-dot" /> marks a
              change from the vertical default.
            </p>
          </div>
          <button className="btn" onClick={() => setDraft(VERTICAL_TIERS.map((t) => ({ ...t })))}>
            Reset to vertical defaults
          </button>
        </div>
        <div className="table-wrap ca-table">
          <table className="table clients">
            <thead>
              <tr>
                <th>Tier</th>
                <th>Grace days</th>
                <th>Agent may go up to</th>
                <th>Prepay after</th>
                <th>A person approves</th>
              </tr>
            </thead>
            <tbody>
              {draft.map((t) => {
                const d = VERTICAL_TIERS.find((v) => v.tier === t.tier)!;
                return (
                  <tr key={t.tier}>
                    <td>
                      <TierTag tier={t.tier} /> <strong>{t.name}</strong>
                    </td>
                    <td>
                      <Stepper
                        value={`${t.graceDays}d`}
                        onDown={() => step(t.tier, 'graceDays', -1)}
                        onUp={() => step(t.tier, 'graceDays', 1)}
                        changed={t.graceDays !== d.graceDays}
                        def={`${d.graceDays}d`}
                      />
                    </td>
                    <td>
                      <Stepper
                        value={LADDER[t.ceiling]!}
                        onDown={() => step(t.tier, 'ceiling', -1)}
                        onUp={() => step(t.tier, 'ceiling', 1)}
                        changed={t.ceiling !== d.ceiling}
                        def={LADDER[d.ceiling]!}
                      />
                    </td>
                    <td>
                      <Stepper
                        value={
                          t.prepayAfter
                            ? `${t.prepayAfter} miss${t.prepayAfter === 1 ? '' : 'es'}`
                            : 'Never'
                        }
                        onDown={() => step(t.tier, 'prepayAfter', -1)}
                        onUp={() => step(t.tier, 'prepayAfter', 1)}
                        changed={t.prepayAfter !== d.prepayAfter}
                        def={d.prepayAfter ? `${d.prepayAfter}` : 'never'}
                      />
                    </td>
                    <td className="muted">
                      {t.tier === 1 ? 'Any restriction' : 'Offboarding · exploit fixes'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="ca-card">
          <h4>Waiting in Approvals</h4>
          <ul className="list">
            {pending.map((p) => (
              <li key={p.key}>
                <span>{p.title}</span>
                <Badge tone="warn">draft v{p.version}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {changed && (
        <div className="ca-draftbar">
          <span>
            <strong>Draft</strong> · {summarize(policy.tiers, draft)}
          </span>
          <input
            className="search ca-reason"
            placeholder="Reasoning for the other controller"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Reasoning"
          />
          <button
            className="btn ghost"
            onClick={() => setDraft(policy.tiers.map((t) => ({ ...t })))}
          >
            Discard
          </button>
          <button
            className="btn primary"
            disabled={busy || !reason.trim() || session.role !== 'CONTROLLER'}
            onClick={submit}
          >
            {busy ? 'Submitting…' : 'Submit for approval'}
          </button>
        </div>
      )}
      {result && <p className={`notice ${result.tone}`}>{result.text}</p>}
    </>
  );
}

function Stepper({
  value,
  onDown,
  onUp,
  changed,
  def,
}: {
  value: string;
  onDown: () => void;
  onUp: () => void;
  changed: boolean;
  def: string;
}) {
  return (
    <span className="ca-stepper">
      <button className="btn icon" onClick={onDown} aria-label="Less">
        −
      </button>
      <span className="mono ca-step-v">{value}</span>
      <button className="btn icon" onClick={onUp} aria-label="More">
        +
      </button>
      {changed && (
        <span className="eyebrow">
          <span className="ca-dot" /> default {def}
        </span>
      )}
    </span>
  );
}

/** One line: what this draft changes against the rules in force. */
function summarize(before: TierRule[], after: TierRule[]): string {
  const out: string[] = [];
  for (const a of after) {
    const b = before.find((x) => x.tier === a.tier)!;
    if (a.topPct !== b.topPct && a.tier < 5) out.push(`T${a.tier} cutoff ${b.topPct}→${a.topPct}%`);
    if (a.graceDays !== b.graceDays) out.push(`T${a.tier} grace ${b.graceDays}→${a.graceDays}d`);
    if (a.ceiling !== b.ceiling) out.push(`T${a.tier} ceiling → ${LADDER[a.ceiling]}`);
    if (a.prepayAfter !== b.prepayAfter)
      out.push(`T${a.tier} prepay after ${a.prepayAfter || 'never'}`);
  }
  return out.join(', ') || 'no changes';
}
