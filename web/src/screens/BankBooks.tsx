import { useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { Badge } from '../components/Badge';
import { Movement } from '../components/Movement';
import { Select } from '../components/Select';
import { tables } from '../module_bindings';
import { ago, useApplications, useArrivals, useBankFeed, usePayerNames, useLatestTieOut, useNow } from '../lib/bank';
import { demo } from '../lib/demo';
import { label, money } from '../lib/format';

const FEED_FILTERS = {
  all: { label: 'All', test: () => true },
  in: { label: 'Received', test: (m: { direction: string }) => m.direction === 'in' },
  out: { label: 'Sent', test: (m: { direction: string }) => m.direction === 'out' },
  person: { label: 'Needs a person', test: (m: { matchStatus: string }) => m.matchStatus === 'exception' },
  transit: { label: 'In transit', test: (m: { status: string }) => m.status === 'pending' },
} as const;
type FeedFilter = keyof typeof FEED_FILTERS;

const AREA: Record<string, { name: string; gl: string }> = {
  'cash:collections': { name: 'Collections', gl: '1010' },
  'cash:disbursements': { name: 'Disbursements', gl: '1011' },
  'cash:wallet': { name: 'USDC wallet (on-chain)', gl: '1015' },
  receivables: { name: 'Receivables (invoices vs GL)', gl: '1200' },
  unapplied: { name: 'Unapplied cash', gl: '2300' },
};

/**
 * The bank as the desk sees it: Nessie accounts against the ledger, every movement
 * as it lands (raw text, what we read, what it paid), and a way to send a wire.
 */
export function BankBooks() {
  const [feed, ready] = useBankFeed();
  const apps = useApplications();
  const names = usePayerNames();
  const fresh = useArrivals(feed.map((m) => m.id), ready);
  const { run, areas } = useLatestTieOut();
  const [breaks] = useTable(tables.tieOutBreak);
  const [accounts] = useTable(tables.bankAccount.where((r) => r.owner.eq('platform')));
  const [sources] = useTable(tables.syncSource);
  const [filter, setFilter] = useState<FeedFilter>('all');
  const now = useNow();

  const bank = sources.find((s) => s.source === 'bank');
  const synced = bank?.lastSyncAt ? ago(now - Number(bank.lastSyncAt.microsSinceUnixEpoch / 1000n)) : '—';
  const runBreaks = useMemo(() => breaks.filter((b) => run && b.runId === run.id), [breaks, run]);
  const shown = feed.filter(FEED_FILTERS[filter].test);
  const tied = run && run.unexplainedCents === 0n;

  return (
    <>
      <p className="muted">
        Live from the platform's bank at Nessie (Capital One): every deposit and withdrawal is read, matched and booked
        as it lands. Bank sync {bank?.status === 'error' ? <span className="bad-text">failing</span> : 'every 5 s'} · last {synced}.
      </p>

      <h4 className="row spread">
        <span>Accounts against the ledger</span>
        {run && (
          <Badge tone={tied ? 'good' : 'bad'}>
            {tied ? 'Tied to the cent' : `${money(run.unexplainedCents)} unexplained`}
          </Badge>
        )}
      </h4>
      <div className="table-wrap">
        <table className="table books">
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Bank / operations</th>
              <th className="num">General ledger</th>
              <th className="num">Difference</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((a) => {
              const meta = AREA[a.area] ?? { name: label(a.area), gl: '' };
              const acct = accounts.find((x) => `cash:${x.id}` === a.area);
              const diff = a.operations - a.ledger;
              return (
                <tr key={a.area}>
                  <td>
                    <div className="title">{meta.name}</div>
                    <span className="eyebrow">
                      {acct ? (
                        <>Nessie acct <span className="mono">…{acct.accountNumber.slice(-4)}</span>{acct.pendingInCents > 0n && ` · ${money(acct.pendingInCents)} arriving`}</>
                      ) : a.area.startsWith('cash:') ? 'Base network' : 'Billing'}
                      {meta.gl && <> · GL {meta.gl}</>}
                    </span>
                  </td>
                  <td className="num mono">{money(a.operations)}</td>
                  <td className="num mono">{money(a.ledger)}</td>
                  <td className={`num mono ${diff === 0n ? 'tie' : 'late'}`}>{diff === 0n ? '✓' : money(diff)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {runBreaks.length > 0 && (
        <ul className="list breaks">
          {runBreaks.map((b) => (
            <li key={String(b.id)}>
              <span>
                <Badge tone={b.kind === 'unexplained' ? 'bad' : 'info'}>{label(b.kind)}</Badge> {b.detail}
              </span>
              <span className="mono">{money(b.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}
      {run && <p className="eyebrow">Last tie-out: {run.trigger} · {ago(now - Number(run.at.microsSinceUnixEpoch / 1000n))}</p>}

      <SendWire />

      <h4>Bank feed</h4>
      <div className="filters" role="toolbar" aria-label="Filter movements">
        {(Object.keys(FEED_FILTERS) as FeedFilter[]).map((k) => (
          <button key={k} className={`filter ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>
            {FEED_FILTERS[k].label}
            <span className="count">{feed.filter(FEED_FILTERS[k].test).length}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="empty">{ready ? 'Nothing here.' : 'Loading the bank feed…'}</div>
      ) : (
        <ul className="list movements">
          {shown.map((m) => (
            <Movement key={m.id} m={m} apps={apps.get(m.id) ?? []} fresh={fresh.has(m.id)} known={names.get(m.origAccount)} />
          ))}
        </ul>
      )}
    </>
  );
}

type Outcome = {
  bankRef: string;
  ms: number;
  matchStatus?: string;
  parsed?: { payer: string; references: string[] };
  applications?: { invoiceId: string; amountCents: string; method: string }[];
  workItems?: { kind: string; title: string; needs: string | null }[];
  holdsReleased?: string[];
};

/** Make up a wire and watch it arrive: it goes into Nessie, then through sync, matching and the books. */
function SendWire() {
  const [clients] = useTable(tables.client);
  const [payer, setPayer] = useState('ORG-90412');
  const [stranger, setStranger] = useState('Tannery Row Holdings LLC');
  const [amount, setAmount] = useState('148200');
  const [remittance, setRemittance] = useState('INV-1747 INV-1748 INV-1749');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; o: Outcome } | { ok: false; error: string }>();

  const options = useMemo(
    () => [
      ...[...clients].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: c.name, hint: c.id })),
      { value: 'unknown', label: 'A payer we have never seen', hint: 'name only' },
    ],
    [clients],
  );

  async function send() {
    setBusy(true);
    setResult(undefined);
    try {
      const o = await demo<Outcome>('inject', {
        payer: payer === 'unknown' ? { name: stranger } : { clientId: payer },
        amount: Number(amount),
        remittance,
      });
      setResult({ ok: true, o });
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const o = result?.ok ? result.o : undefined;
  return (
    <div className="send-wire">
      <h4>Send a wire</h4>
      <div className="send-wire-form">
        <Select label="Payer" value={payer} onChange={setPayer} options={options} />
        {payer === 'unknown' && (
          <input className="field" value={stranger} onChange={(e) => setStranger(e.target.value)} aria-label="Payer name" />
        )}
        <input className="field mono" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in dollars" />
        <input className="field grow" value={remittance} onChange={(e) => setRemittance(e.target.value)} placeholder="Remittance, as the payer would type it" aria-label="Remittance" />
        <button className="btn primary" disabled={busy || !Number(amount)} onClick={send}>
          {busy ? 'Sending…' : 'Send wire'}
        </button>
      </div>
      {result && !result.ok && <div className="notice bad">{result.error}</div>}
      {o && (
        <div className="notice good">
          <strong>{o.bankRef}</strong> landed in Nessie and was read in {(o.ms / 1000).toFixed(1)} s ·{' '}
          {o.applications?.length
            ? `applied to ${o.applications.map((a) => `${a.invoiceId} (${label(a.method)})`).join(', ')}`
            : o.workItems?.length
              ? o.workItems.map((w) => `${label(w.kind)}${w.needs ? ` · needs ${w.needs.toLowerCase()}` : ''}`).join(', ')
              : label(o.matchStatus ?? 'received')}
          {o.holdsReleased?.length ? ` · ${o.holdsReleased.length} hold released` : ''}
        </div>
      )}
    </div>
  );
}
