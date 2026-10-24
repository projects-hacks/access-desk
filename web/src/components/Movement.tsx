import type { CashMovement, PaymentApplication } from '../module_bindings/types';
import { matchBadge, nessieId, rail } from '../lib/bank';
import { shortDate } from '../lib/clients';
import { label, money, percent } from '../lib/format';
import { Badge } from './Badge';

/**
 * One bank movement, the way it arrived and the way the desk read it:
 * raw Nessie text → parsed fields → the invoices it paid.
 */
export function Movement({ m, apps, fresh, known }: { m: CashMovement; apps: PaymentApplication[]; fresh?: boolean; known?: string }) {
  const status = matchBadge(m);
  const out = m.direction === 'out';
  const id = nessieId(m);
  return (
    <li className={`movement ${fresh ? 'fresh' : ''}`}>
      <details>
        <summary>
          <span className="movement-date mono">{shortDate(m.valueOn)}</span>
          <span className="movement-who">
            <strong>{m.origName || known || (m.origAccount ? `Unknown wallet ${m.origAccount.slice(0, 8)}…` : out ? 'Outgoing' : 'Unknown payer')}</strong>
            <span className="eyebrow">
              {rail(m)} · <span className="mono">{m.bankRef}</span>
              {m.refs.length > 0 && ` · ${m.refs.join(' ')}`}
            </span>
          </span>
          <span className={`movement-amount mono ${out ? 'out' : 'in'}`}>
            {out ? '−' : '+'}
            {money(m.amountCents)}
          </span>
          <Badge tone={status.tone}>{status.label}</Badge>
        </summary>
        <div className="movement-body">
          <div className="eyebrow">From the bank (Nessie){id && <> · record <span className="mono">{id}</span></>}</div>
          <pre className="raw">{m.memo}</pre>
          <div className="eyebrow">Read as</div>
          <ul className="list kv">
            <li><span>Type</span><span>{label(m.category)} · {rail(m)}</span></li>
            {m.origAccount && <li><span>{out ? 'Beneficiary account' : 'Payer account'}</span><span className="mono">{m.origAccount}</span></li>}
            <li><span>References</span><span className="mono">{m.refs.join(' ') || '—'}</span></li>
            {m.remittance && <li><span>Remittance</span><span>{m.remittance}</span></li>}
            {m.instructedCents !== undefined && (
              <li><span>Sent / charges</span><span className="mono">{money(m.instructedCents)} / {money(m.chargesCents ?? 0n)} {m.chargeBearer ?? ''}</span></li>
            )}
            <li>
              <span>Read by</span>
              <span>{m.parsedBy === 'claude' ? 'Claude' : 'rules'} · confidence {percent(m.parseConfidence)}</span>
            </li>
          </ul>
          {m.parseNotes && <p className="muted small">{m.parseNotes}</p>}
          {apps.length > 0 && (
            <>
              <div className="eyebrow">Applied to</div>
              <ul className="list kv">
                {apps.map((a) => (
                  <li key={String(a.id)}>
                    <span className="mono">{a.invoiceId}</span>
                    <span className="mono">
                      {money(a.amountCents)} · {label(a.method)}
                      {a.policyRef && ` · ${a.policyRef}`}
                      {a.posted ? ' · billing confirmed' : ' · billing pending'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </details>
    </li>
  );
}
