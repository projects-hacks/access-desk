import { Lock } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { Select } from '../components/Select';
import { SlidingPill } from '../components/SlidingPill';
import {
  LEVERS,
  daysBetween,
  shortDate,
  useClientRows,
  type ClientRow,
  type Lever,
} from '../lib/clients';
import { demo } from '../lib/demo';
import { money } from '../lib/format';
import { PERMISSION_GROUPS, permissionOn } from '../lib/permissions';
import { bindTo, placeOrder, usePortal, type PortalSnapshot } from '../lib/portal';
import { useClock, usePlatform, useSimTime } from '../lib/session';
import { tables } from '../module_bindings';
import type { AssetPrice, BankAccount, TradeOrder } from '../module_bindings/types';

/** How the client hears about each paused permission: plain words, no internal codes. */
const PAUSED_COPY: Record<string, string> = {
  crypto_withdrawals: 'Crypto withdrawals',
  fiat_withdrawals: 'Cash withdrawals',
  transfers: 'Transfers between portfolios',
  staking: 'Staking',
  buy: 'Buying',
  sell: 'Selling',
  derivatives: 'Derivatives trading',
  otc: 'OTC desk trades',
  api: 'API trading',
  borrowing: 'New borrowing',
};

/** An agent step on a whole product (no fine permissions): how the client names it. */
const LEVER_COPY: Record<string, string> = {
  withdrawals: 'Withdrawals',
  trading: 'Trading',
  api: 'API access',
  financing: 'New borrowing',
};

/** "Withdrawals and buying are paused": the paused items as one plain sentence. */
function pausedSentence(paused: Paused[]): string {
  const words = [...new Set(paused.map((p) => p.label))].map((w, i) =>
    i === 0 || /^[A-Z]{2,}/.test(w) ? w : w.charAt(0).toLowerCase() + w.slice(1),
  );
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '');
  return `${list} ${words.length > 1 || /[^s]s$/.test(list) ? 'are' : 'is'} paused`;
}

const PAGES = { home: 'Home', assets: 'My assets', pay: 'Pay balance' } as const;
type Page = keyof typeof PAGES;

type Paused = { key: string; label: string; detail?: string };
/** What the screen needs about one client; the staff list's ClientRow fits it too. */
type Row = Pick<
  ClientRow,
  'client' | 'levers' | 'invoices' | 'unpaidCents' | 'overdueCents' | 'daysPastDue'
>;
type Holding = { asset: string; quantity: number; valueCents: bigint };

const COIN: Record<string, { name: string; color: string; glyph: string }> = {
  BTC: { name: 'Bitcoin', color: '#f7931a', glyph: '₿' },
  ETH: { name: 'Ethereum', color: '#627eea', glyph: 'Ξ' },
  SOL: { name: 'Solana', color: '#9945ff', glyph: 'S' },
  USDC: { name: 'USD Coin', color: '#2775ca', glyph: '$' },
  USD: { name: 'US Dollar', color: '#098551', glyph: '$' },
};

/** Everything the client can't do right now, from permissions, levers and holds. */
function pausedFor(row: Row, permissions: Parameters<typeof permissionOn>[1]): Paused[] {
  const out: Paused[] = [];
  for (const g of PERMISSION_GROUPS) {
    const lever = row.levers.find((l) => l.key === g.lever);
    if (!lever || lever.state === 'not_used' || lever.state === 'active') continue;
    const fine = g.items.filter((p) =>
      permissions.some((x) => x.clientId === row.client.id && x.key === p.key),
    );
    if (fine.length) {
      for (const p of g.items)
        if (!permissionOn(row, permissions, p.key, g.lever))
          out.push({ key: p.key, label: PAUSED_COPY[p.key] ?? p.name });
    } else if (g.lever === 'trading') {
      // Agent steps on trading: no new positions / close-only stop buying but keep selling.
      if (lever.state === 'off')
        out.push({ key: 'buy', label: 'Buying' }, { key: 'sell', label: 'Selling' });
      else if (/OTC/i.test(lever.detail)) out.push({ key: 'otc', label: 'OTC desk trades' });
      else out.push({ key: 'buy', label: 'Buying', detail: lever.detail });
    } else {
      // Other agent steps (a hold, read-only API...): one line for the product.
      out.push({ key: g.lever, label: LEVER_COPY[g.lever] ?? g.name, detail: lever.detail });
    }
  }
  return out;
}

/** The bound client's row, built only from the portal connection's views (same math as useClientRows). */
function portalRow(p: PortalSnapshot, today: string): Row | undefined {
  if (!p.client) return undefined;
  const owed = (i: (typeof p.invoices)[number]) => i.amountCents - i.paidCents;
  const unpaid = p.invoices.filter((i) => i.status !== 'void' && owed(i) > 0n);
  const overdue = unpaid.filter((i) => i.dueOn < today && i.status !== 'disputed');
  const sum = (xs: typeof unpaid) => xs.reduce((s, i) => s + owed(i), 0n);
  const oldest = overdue.map((i) => i.dueOn).sort()[0];
  const levers: Lever[] = LEVERS.map((l) => {
    const r = p.levers.find((x) => x.lever === l.key);
    return { ...l, state: r?.state ?? 'not_used', detail: r?.detail ?? '' };
  });
  return {
    client: p.client,
    levers,
    invoices: [...p.invoices].sort((a, b) => (a.dueOn < b.dueOn ? 1 : -1)),
    unpaidCents: sum(unpaid),
    overdueCents: sum(overdue),
    daysPastDue: oldest && today ? daysBetween(oldest, today) : 0,
  };
}

const can = (paused: Paused[], ...keys: string[]) => !paused.some((p) => keys.includes(p.key));
const usesLever = (row: Row, lever: string) =>
  row.levers.some((l) => l.key === lever && l.state !== 'not_used');

/**
 * What the client sees on their own platform, laid out like a retail exchange's web app
 * (sidebar · balance and assets · trade panel): their money, what's paused and why, and
 * how to get it back.
 */
export function ClientPortal() {
  // Staff connection: only the demo picker (names, "paused" hints, the default pick),
  // the platform's wire instructions and the clock. Client data comes from the portal.
  const rows = useClientRows();
  const [staffPermissions, permissionsReady] = useTable(tables.permission);
  // The default pick needs the whole staff picture (levers, invoices, clock), not a partial one.
  const [, leversReady] = useTable(tables.accessLever);
  const [, invoicesReady] = useTable(tables.invoice);
  const platform = usePlatform();
  const today = useClock()?.simDate ?? '';
  const portal = usePortal();
  const [pending, setPending] = useState<string>();
  const [bindError, setBindError] = useState<string>();
  const autoBound = useRef(false);
  const [page, setPage] = useState<Page>('home');
  const [panel, setPanel] = useState<'trade' | 'withdraw'>('trade');
  const [dismissed, setDismissed] = useState('');

  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.client.name.localeCompare(b.client.name)),
    [rows],
  );
  // Starts on the most overdue client with something paused, so there's a restriction to show.
  const fallback = (
    [...rows]
      .filter((r) => pausedFor(r, staffPermissions).length)
      .sort((a, b) => b.daysPastDue - a.daysPastDue)[0] ?? sorted[0]
  )?.client.id;

  function viewAs(id: string) {
    setPending(id);
    setBindError(undefined);
    bindTo(id).catch((e) => {
      setPending(undefined);
      setBindError(e instanceof Error ? e.message : String(e));
    });
  }

  // First open: a fresh portal identity isn't bound to anyone yet, so its views are empty.
  useEffect(() => {
    const staffReady = permissionsReady && leversReady && invoicesReady && !!today;
    if (!portal.ready || portal.clientId || !staffReady || !fallback || autoBound.current) return;
    autoBound.current = true;
    viewAs(fallback);
  }, [portal.ready, portal.clientId, fallback, permissionsReady, leversReady, invoicesReady, today]);

  // The views have caught up with the picker.
  useEffect(() => {
    if (pending && portal.clientId === pending) setPending(undefined);
  }, [pending, portal.clientId]);

  const row = portalRow(portal, today);
  if (!row)
    return (
      <div className="empty">
        {bindError ? (
          <>
            {bindError}{' '}
            <button className="btn ghost" onClick={() => fallback && viewAs(fallback)}>
              Retry
            </button>
          </>
        ) : (
          portal.error ?? 'Opening a private portal connection…'
        )}
      </div>
    );

  const paused = pausedFor(row, portal.permissions);
  const own = [...portal.holdings].sort((a, b) => Number(b.valueCents - a.valueCents));
  const total = own.reduce((s, h) => s + h.valueCents, 0n);
  const usd = own.find((h) => h.asset === 'USD')?.valueCents ?? 0n;
  const showBanner = paused.length > 0 && dismissed !== row.client.id;

  return (
    <section>
      <div className="screen-head">
        <div>
          <h2>Client view</h2>
          <p className="muted">What a client sees in their own app when access is paused.</p>
          <p className="cx-private">
            <Lock size={12} aria-hidden />
            Private connection
          </p>
          {bindError && <p className="notice bad">{bindError}</p>}
        </div>
        <label className="viewing-as">
          <span className="eyebrow">Viewing as</span>
          <Select
            label="Client"
            value={pending ?? row.client.id}
            onChange={(id) => {
              if (id === (pending ?? row.client.id)) return;
              viewAs(id);
              setPage('home');
              setPanel('trade');
            }}
            options={sorted.map((r) => ({
              value: r.client.id,
              label: r.client.name,
              hint: pausedFor(r, staffPermissions).length ? 'paused' : undefined,
            }))}
          />
        </label>
      </div>

      <div className={`cx ${pending ? 'cx-switching' : ''}`} aria-busy={!!pending}>
        <aside className="cx-side">
          <div className="cx-logo" title={platform?.name ?? 'Northstar Prime'} />
          <nav aria-label="Client app">
            {(Object.keys(PAGES) as Page[]).map((p) => (
              <button
                key={p}
                className={page === p ? 'active' : ''}
                aria-current={page === p ? 'page' : undefined}
                onClick={() => setPage(p)}
              >
                <span className="cx-navdot" />
                {PAGES[p]}
                {p === 'pay' && row.overdueCents > 0n && <span className="cx-reddot" />}
              </button>
            ))}
          </nav>
          <div className="cx-who">
            <strong>{row.client.name}</strong>
            <span>{platform?.name ?? 'Northstar Prime'}</span>
          </div>
        </aside>

        <div className="cx-main">
          <header className="cx-head">
            <h3>{PAGES[page]}</h3>
            <div className="cx-search">Search for an asset</div>
          </header>
          <div className="cx-content">
            {showBanner && (
              <div className="cx-alert" role="status">
                <span className="cx-alert-icon">!</span>
                <div>
                  <strong>Some actions on your account are paused</strong>
                  <p>
                    {row.overdueCents > 0n
                      ? `${money(row.overdueCents)} is ${row.daysPastDue} days overdue. ${pausedSentence(paused)} until it's paid; access comes back automatically.`
                      : `${pausedSentence(paused)}. Contact your relationship manager.`}
                  </p>
                  {row.overdueCents > 0n && page !== 'pay' && (
                    <button className="cx-link" onClick={() => setPage('pay')}>
                      Pay {money(row.overdueCents)}
                    </button>
                  )}
                </div>
                <button
                  className="cx-close"
                  aria-label="Dismiss"
                  onClick={() => setDismissed(row.client.id)}
                >
                  ×
                </button>
              </div>
            )}

            {page === 'home' && (
              <>
                <div className="cx-card">
                  <div className="cx-card-title">My balance</div>
                  <div className="cx-balance">
                    <span className="cx-cur">$</span>
                    {money(total).replace('$', '')}
                  </div>
                </div>
                <h4 className="cx-section">Your assets</h4>
                <Assets holdings={own} />
                <h4 className="cx-section">Account access</h4>
                <Access row={row} paused={paused} />
              </>
            )}
            {page === 'assets' && <Assets holdings={own} />}
            {page === 'pay' && (
              <Pay
                row={row}
                wire={platform?.wireInstructions ?? ''}
                accounts={portal.bankAccounts}
                accessBack={paused.length === 0}
              />
            )}
          </div>
        </div>

        <aside className="cx-panel">
          {panel === 'trade' ? (
            <TradePanel
              key={row.client.id}
              row={row}
              paused={paused}
              prices={portal.prices}
              orders={portal.orders}
              onWithdraw={() => setPanel('withdraw')}
              onDeposit={() => setPage('pay')}
            />
          ) : (
            <WithdrawPanel row={row} paused={paused} usd={usd} onBack={() => setPanel('trade')} />
          )}
        </aside>
      </div>
    </section>
  );
}

function Assets({ holdings }: { holdings: Holding[] }) {
  if (!holdings.length) return <div className="cx-card muted">No assets held with us.</div>;
  return (
    <div className="cx-card cx-rows">
      {holdings.map((h) => {
        const c = COIN[h.asset] ?? { name: h.asset, color: '#5b616e', glyph: h.asset[0] };
        return (
          <div key={h.asset} className="cx-asset-row">
            <span className="cx-coin" style={{ background: c.color }}>
              {c.glyph}
            </span>
            <span className="cx-asset-name">
              <strong>{c.name}</strong>
              <span>{h.asset}</span>
            </span>
            <span className="cx-qty">
              {h.asset === 'USD'
                ? 'Cash'
                : `${h.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${h.asset}`}
            </span>
            <span className="cx-amt">{money(h.valueCents)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Access({ row, paused }: { row: Row; paused: Paused[] }) {
  if (!paused.length)
    return <div className="cx-card cx-ok">Everything on your account is available.</div>;
  return (
    <div className="cx-card cx-rows">
      {paused.map((p) => (
        <div key={p.key} className="cx-access-row">
          <span>{p.label}</span>
          <span className="cx-tag">{p.detail ?? 'Paused'}</span>
        </div>
      ))}
      <p className="cx-foot">
        Paused until your overdue balance is paid. Everything else keeps working
        {usesLever(row, 'trading') && can(paused, 'sell')
          ? ', including selling and closing positions.'
          : '.'}
      </p>
    </div>
  );
}

const SIDES = { buy: 'Buy', sell: 'Sell' } as const;
type Side = keyof typeof SIDES;
const TRADED = ['BTC', 'ETH'] as const;

const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

/** One order in words: what happened, not what the database stores. */
function orderWords(o: TradeOrder): string {
  const buy = o.side === 'buy';
  const coin = COIN[o.asset]?.name ?? o.asset;
  if (o.status === 'refused') return `${buy ? 'Buy' : 'Sell'} refused · ${coin}`;
  if (o.status === 'filled') return `${buy ? 'Bought' : 'Sold'} ${qty(o.quantity)} ${o.asset}`;
  return `${buy ? 'Buying' : 'Selling'} ${coin}…`;
}

/** Right panel: buy / sell Bitcoin or Ethereum at the live price, and the money actions underneath. */
function TradePanel({
  row,
  paused,
  prices,
  orders,
  onWithdraw,
  onDeposit,
}: {
  row: Row;
  paused: Paused[];
  prices: AssetPrice[];
  orders: TradeOrder[];
  onWithdraw: () => void;
  onDeposit: () => void;
}) {
  const [side, setSide] = useState<Side>('buy');
  const [asset, setAsset] = useState<(typeof TRADED)[number]>('BTC');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Newest order id when "Buy" was pressed: the answer is the first order after it.
  const [after, setAfter] = useState<bigint>();
  const simTime = useSimTime();
  const trading = usesLever(row, 'trading');
  const hint = !trading || !can(paused, side);
  const withdrawals = usesLever(row, 'withdrawals');
  const cashBlocked = !can(paused, 'fiat_withdrawals');
  const cryptoBlocked = !can(paused, 'crypto_withdrawals');

  const price = prices.find((p) => p.asset === asset)?.priceCents;
  const dollars = Number(amount);
  const estimate = price && dollars > 0 ? (dollars * 100) / Number(price) : 0;
  const mine = useMemo(() => [...orders].sort((a, b) => (a.id < b.id ? 1 : -1)), [orders]);
  const answer = after === undefined ? undefined : [...mine].reverse().find((o) => o.id > after);
  const earlier = mine.filter((o) => o !== answer);
  const name = COIN[asset]?.name ?? asset;

  async function submit() {
    setBusy(true);
    setError(undefined);
    setAfter(mine[0]?.id ?? 0n);
    try {
      // The button is never disabled by what the screen thinks is paused: the database decides.
      await placeOrder(row.client.id, side, asset, BigInt(Math.round(dollars * 100)));
    } catch (e) {
      setAfter(undefined);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const actions = [
    // Custody isn't on every account: those actions say so instead of "Paused".
    {
      key: 'send',
      icon: '↑',
      label: 'Send crypto',
      off: !withdrawals || cryptoBlocked,
      why: withdrawals ? 'Paused' : 'Not on your account',
    },
    {
      key: 'receive',
      icon: '↓',
      label: 'Receive crypto',
      off: !withdrawals,
      why: 'Not on your account',
    },
    { key: 'deposit', icon: '⊟', label: 'Deposit cash', off: false, why: '' },
    {
      key: 'withdraw',
      icon: '⊟',
      label: 'Withdraw cash',
      off: !withdrawals || cashBlocked,
      why: withdrawals ? 'Paused' : 'Not on your account',
    },
  ];
  const onAction: Record<string, () => void> = { withdraw: onWithdraw, deposit: onDeposit };

  return (
    <>
      <div className="cx-sides" role="tablist">
        <SlidingPill active={side} className="dark" />
        {(Object.keys(SIDES) as Side[]).map((s) => (
          <button
            key={s}
            role="tab"
            data-active={side === s}
            aria-selected={side === s}
            onClick={() => {
              setSide(s);
              setAfter(undefined);
            }}
          >
            {SIDES[s]}
          </button>
        ))}
      </div>
      <div className="cx-assetpick" role="group" aria-label="Asset">
        {TRADED.map((a) => (
          <button
            key={a}
            className={asset === a ? 'active' : ''}
            aria-pressed={asset === a}
            onClick={() => {
              setAsset(a);
              setAfter(undefined);
            }}
          >
            {COIN[a]?.name ?? a}
          </button>
        ))}
      </div>
      <div className="cx-big cx-input">
        <input
          inputMode="decimal"
          placeholder="0"
          value={amount}
          style={{ width: `${Math.max(1, amount.length) + 0.3}ch` }}
          onChange={(e) => {
            setAmount(e.target.value.replace(/[^0-9.]/g, ''));
            setAfter(undefined);
          }}
          aria-label="Amount in US dollars"
        />
        USD
      </div>
      <div className="cx-conv">
        {price
          ? estimate > 0
            ? `≈ ${qty(estimate)} ${asset} at ${money(price)}`
            : `${name} is ${money(price)}`
          : 'Fetching the price…'}
      </div>
      <button
        className="btn primary cx-cta"
        disabled={busy || !(dollars > 0) || !price}
        onClick={submit}
      >
        {busy ? 'Placing order…' : `${SIDES[side]} ${name}`}
      </button>
      {hint && !answer && (
        <p className="cx-why">
          {trading
            ? `${SIDES[side] === 'Buy' ? 'Buying' : 'Selling'} is paused until your overdue balance is paid.`
            : 'Trading is not on your account.'}
          {trading && side === 'buy' && can(paused, 'sell')
            ? ' You can still sell and close positions, so your hedges stay intact.'
            : ''}
        </p>
      )}
      {error && <p className="notice bad">{error}</p>}
      {!error && after !== undefined && (answer ? <OrderAnswer o={answer} /> : <p className="cx-foot">Placing your order…</p>)}

      {earlier.length > 0 && (
        <>
          <h4 className="cx-section">Recent orders</h4>
          <ul className="cx-orders">
            {earlier.slice(0, 4).map((o) => (
              <li key={String(o.id)} className={o.status}>
                <span>
                  <strong>{orderWords(o)}</strong>
                  <span className="muted">
                    {o.status === 'refused' ? o.reason : [money(o.amountCents), simTime(o.at)].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {o.status === 'refused' && <span className="cx-tag">Refused</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      <hr className="cx-rule" />
      <div className="cx-actions">
        {actions.map((a) => (
          <button
            key={a.key}
            className={a.off ? 'off' : ''}
            onClick={onAction[a.key]}
            disabled={!onAction[a.key] && a.off}
          >
            <span className="cx-action-icon">{a.icon}</span>
            {a.label}
            {a.off && <span className={`cx-tag ${a.why === 'Paused' ? '' : 'na'}`}>{a.why}</span>}
          </button>
        ))}
      </div>
    </>
  );
}

/** The database's answer to the order just placed: filled, or refused with its reason. */
function OrderAnswer({ o }: { o: TradeOrder }) {
  if (o.status === 'refused')
    return (
      <div className="cx-outcome warn" role="status">
        <strong>{o.side === 'buy' ? 'Buy' : 'Sell'} refused</strong>
        <p>{o.reason}</p>
      </div>
    );
  if (o.status === 'filled')
    return (
      <div className="cx-outcome good" role="status">
        <strong>{orderWords(o)}</strong>
        <p>
          {money(o.amountCents)} at {money(o.priceCents)}
        </p>
      </div>
    );
  return <p className="cx-foot">Placing your order…</p>;
}

type WithdrawResult = {
  decision: string;
  requestedCents: string;
  releasedCents: string;
  heldCents: string;
  reason: string;
};

function WithdrawPanel({
  row,
  paused,
  usd,
  onBack,
}: {
  row: Row;
  paused: Paused[];
  usd: bigint;
  onBack: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WithdrawResult>();
  const [error, setError] = useState<string>();
  const frozen =
    !usesLever(row, 'withdrawals') ||
    !can(paused, 'fiat_withdrawals') ||
    row.levers.some((l) => l.key === 'withdrawals' && l.state === 'off');
  const value = Number(amount);

  async function withdraw() {
    if (
      !confirm(
        `Send a real demo withdrawal of $${value.toLocaleString()} through the bank sandbox? It changes the shared demo data.`,
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await demo<WithdrawResult>('withdraw', { clientId: row.client.id, amount: value }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="cx-back" onClick={onBack} aria-label="Back">
        ←
      </button>
      <h3 className="cx-panel-title">Withdraw cash</h3>
      <div className="cx-big cx-input">
        <input
          inputMode="decimal"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          aria-label="Amount in US dollars"
          disabled={frozen}
        />
        USD
      </div>
      <div className="cx-field">
        <span>From</span>
        <strong>USD balance · {money(usd)}</strong>
      </div>
      <div className="cx-field">
        <span>To</span>
        <strong>Bank account on file</strong>
      </div>
      <button
        className="btn primary cx-cta"
        disabled={frozen || busy || !(value > 0)}
        onClick={withdraw}
      >
        {frozen ? 'Cash withdrawals are paused' : busy ? 'Sending…' : 'Continue'}
      </button>
      {frozen && usesLever(row, 'withdrawals') && (
        <p className="cx-why">Cash withdrawals are paused until your overdue balance is paid.</p>
      )}
      {error && <p className="notice bad">{error}</p>}
      {result && <WithdrawOutcome r={result} />}
    </>
  );
}

function WithdrawOutcome({ r }: { r: WithdrawResult }) {
  const released = BigInt(r.releasedCents);
  const held = BigInt(r.heldCents);
  const tone = held === 0n ? 'good' : released > 0n ? 'warn' : 'bad';
  return (
    <div className={`cx-outcome ${tone}`}>
      <strong>
        {held === 0n
          ? `${money(released)} is on its way`
          : released > 0n
            ? `${money(released)} sent · ${money(held)} held`
            : 'Withdrawal held'}
      </strong>
      {held > 0n && (
        <p>
          {money(held)} stays in your account until your overdue balance is paid
          {r.reason ? ` (${r.reason})` : ''}.
        </p>
      )}
    </div>
  );
}

type PayResult = { ms: number; cents: bigint };

/** The account on file to pay from: the main one, in the words the client knows it by. */
function accountOnFile(accounts: BankAccount[], clientId: string) {
  const a = accounts.find((x) => x.id === clientId) ?? accounts.find((x) => !x.id.includes(':')) ?? accounts[0];
  if (!a) return undefined;
  const kind = a.nickname.split('·')[1]?.trim();
  return { name: kind ? `${kind} account` : 'your account', last4: a.accountNumber.slice(-4) };
}

function Pay({
  row,
  wire,
  accounts,
  accessBack,
}: {
  row: Row;
  wire: string;
  accounts: BankAccount[];
  accessBack: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState<PayResult>();
  const [error, setError] = useState<string>();
  const open = row.invoices.filter(
    (i) => i.status !== 'void' && i.paidCents < i.amountCents && i.status !== 'disputed',
  );
  const account = accountOnFile(accounts, row.client.id);
  const due = row.overdueCents;

  async function pay() {
    if (
      !confirm(
        `Send a real demo wire of ${money(due)} from the bank sandbox account? It changes the shared demo data.`,
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    setPaid(undefined);
    try {
      const r = await demo<{ ms: number }>('pay', { clientId: row.client.id });
      setPaid({ ms: r.ms, cents: due });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Whether access is back comes from the live data, not from the response.
  const receipt = paid && (
    <div className="cx-outcome good" role="status">
      <strong>
        Paid {money(paid.cents)}
        {due === 0n && accessBack ? ' · access restored' : ''}
      </strong>
      <p>
        {due === 0n
          ? accessBack
            ? `Everything on your account is available again. Done in ${(paid.ms / 1000).toFixed(1)}s.`
            : `Payment received in ${(paid.ms / 1000).toFixed(1)}s. Restoring your access…`
          : `Payment sent in ${(paid.ms / 1000).toFixed(1)}s. Matching it to your invoices…`}
      </p>
    </div>
  );

  if (!open.length)
    return (
      <>
        {receipt}
        <div className="cx-card">
          <div className="cx-balance">You're all paid up</div>
          <p className="muted">Nothing is owed. Any paused access comes back automatically.</p>
        </div>
        <h4 className="cx-section">Deposit by wire</h4>
        <WireCard row={row} wire={wire} />
      </>
    );
  return (
    <>
      {receipt}
      <div className="cx-card">
        <div className="cx-card-title">Amount due</div>
        <div className="cx-balance">
          <span className="cx-cur">$</span>
          {money(row.unpaidCents).replace('$', '')}
        </div>
        {due > 0n && <p className="cx-why">{money(due)} is past due.</p>}
        {due > 0n && account && (
          <button className="btn primary cx-cta cx-pay" disabled={busy} onClick={pay}>
            {busy ? 'Sending payment…' : `Pay ${money(due)} now from ${account.name} ••${account.last4}`}
          </button>
        )}
        {error && <p className="notice bad">{error}</p>}
      </div>
      <div className="cx-card cx-rows">
        {open.map((i) => (
          <div key={i.id} className="cx-asset-row">
            <span className="cx-asset-name">
              <strong>{i.label || i.id}</strong>
              <span>
                {i.id} · due {shortDate(i.dueOn)}
              </span>
            </span>
            <span className="cx-amt">{money(i.amountCents - i.paidCents)}</span>
          </div>
        ))}
      </div>
      <h4 className="cx-section">Or pay by wire</h4>
      <WireCard row={row} wire={wire} />
    </>
  );
}

function WireCard({ row, wire }: { row: Row; wire: string }) {
  return (
    <div className="cx-card">
      <p className="cx-wire">{wire || <span className="muted">-</span>}</p>
      <p className="cx-foot">
        Use <strong className="mono">{row.client.id}</strong> and the invoice numbers as the
        reference. Access comes back as soon as the payment arrives.
      </p>
    </div>
  );
}
