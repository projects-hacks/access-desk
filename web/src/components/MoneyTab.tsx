import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { useApplications, useArrivals, useBankFeed, usePayerNames } from '../lib/bank';
import { shortDate, type ClientRow } from '../lib/clients';
import { money } from '../lib/format';
import { Badge } from './Badge';
import { Movement } from './Movement';

/** The client's money: custody, their bank account at Nessie, payments, holds and withdrawals. */
export function MoneyTab({ row }: { row: ClientRow }) {
  const id = row.client.id;
  const [holdings] = useTable(tables.custodyHolding.where((r) => r.clientId.eq(id)));
  const [holds] = useTable(tables.hold.where((r) => r.clientId.eq(id)));
  const [requests] = useTable(tables.accessRequest.where((r) => r.clientId.eq(id)));
  const [accounts] = useTable(tables.bankAccount.where((r) => r.owner.eq(id)));
  const [identities] = useTable(tables.payerIdentity.where((r) => r.clientId.eq(id)));
  const [feed, feedReady] = useBankFeed();
  const apps = useApplications();
  const names = usePayerNames();

  // A movement is this client's if it came from (or went to) one of their accounts,
  // paid one of their invoices, or quotes their client id.
  const payments = useMemo(() => {
    const theirs = new Set(identities.map((p) => p.value));
    const invoices = new Set(row.invoices.map((i) => i.id));
    return feed.filter(
      (m) =>
        theirs.has(m.origAccount) ||
        (apps.get(m.id) ?? []).some((a) => invoices.has(a.invoiceId)) ||
        m.refs.includes(id),
    );
  }, [feed, identities, apps, row.invoices, id]);
  const fresh = useArrivals(payments.map((m) => m.id), feedReady);

  const usd = holdings.find((h) => h.asset === 'USD')?.valueCents ?? 0n;
  const total = holdings.reduce((s, h) => s + h.valueCents, 0n);
  const held = holds.filter((h) => h.status === 'active').reduce((s, h) => s + h.amountCents, 0n);
  const available = usd > held ? usd - held : 0n;
  const recent = [...requests].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 5);

  return (
    <>
      <div className="stats">
        <Stat label="Custody" value={money(total, true)} />
        <Stat label="USD cash" value={money(usd)} />
        <Stat label="Held" value={held ? money(held) : '-'} bad={held > 0n} />
        <Stat label="Withdrawable" value={money(available)} />
      </div>

      <h4>Custody</h4>
      {holdings.length === 0 ? (
        <p className="muted">No assets in custody.</p>
      ) : (
        <ul className="list">
          {holdings.map((h) => (
            <li key={h.id}>
              <span>{h.asset}</span>
              <span className="tnum">
                {h.asset === 'USD' ? '' : `${h.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })} · `}
                {money(h.valueCents)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {(holds.length > 0 || recent.length > 0) && (
        <>
          <h4>Holds and withdrawals</h4>
          <ul className="list">
            {holds.map((h) => (
              <li key={`h${h.id}`} className="stack">
                <span className="row spread">
                  <strong>Hold {money(h.amountCents)}</strong>
                  <Badge tone={h.status === 'active' ? 'warn' : 'neutral'}>{h.status === 'active' ? 'Active' : 'Released'}</Badge>
                </span>
                <span className="eyebrow">§{h.clause} · secures {h.invoiceIds.join(', ') || 'overdue invoices'}</span>
              </li>
            ))}
            {recent.map((r) => (
              <li key={`r${r.id}`} className="stack">
                <span className="row spread">
                  <strong>Asked to withdraw {money(r.amountCents)}</strong>
                  <Badge tone={r.decision === 'approved' ? 'good' : r.decision === 'partial' ? 'warn' : 'bad'}>
                    {money(r.allowedCents)} released{r.heldCents > 0n ? ` · ${money(r.heldCents)} held` : ''}
                  </Badge>
                </span>
                <span className="eyebrow">{r.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Bank account · Nessie</h4>
      {accounts.length === 0 ? (
        <p className="muted">No account on file.</p>
      ) : (
        <ul className="list">
          {accounts.map((a) => (
            <li key={a.id} className="stack">
              <span className="row spread">
                <strong>{a.nickname}</strong>
                <span className="tnum">{money(a.postedCents)}</span>
              </span>
              <span className="eyebrow">
                Acct <span className="mono">…{a.accountNumber.slice(-4)}</span> · statement as of {shortDate(a.asOf)}
                {a.pendingInCents > 0n && ` · ${money(a.pendingInCents)} arriving`}
                {a.pendingOutCents > 0n && ` · ${money(a.pendingOutCents)} leaving`}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4>Payments</h4>
      {payments.length === 0 ? (
        <p className="muted">No bank movements in this window.</p>
      ) : (
        <ul className="list movements">
          {payments.map((m) => (
            <Movement key={m.id} m={m} apps={apps.get(m.id) ?? []} fresh={fresh.has(m.id)} known={names.get(m.origAccount)} />
          ))}
        </ul>
      )}
    </>
  );
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="stat">
      <div className="eyebrow">{label}</div>
      <div className={`stat-value ${bad ? 'late' : ''} ${value === '-' ? 'muted' : ''}`}>{value}</div>
    </div>
  );
}
