import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, chooseEvent, seeded, type ClientView, type InvoiceView, type PlannedEvent, type WorldSnapshot } from './events';
import type { Profile } from './personality';

const cfg = { clientDayCap: 2 };

const profile = (over: Partial<Profile> = {}): Profile => ({
  clientId: 'ORG-X', name: 'Xylo Capital', personality: 'on_time', medianLate: 0, rail: 'WIRE', reference: 'invoices', international: false,
  overpays: false, duplicates: false, typos: false, ...over,
});
const invoice = (n: number, dueOn: string, over: Partial<InvoiceView> = {}): InvoiceView => ({
  id: `INV-${1200 + n}`, product: 'CUSTODY', dueOn, amountCents: 1_000_000, paidCents: 0, disputed: false, inFlight: false, ...over,
});
const client = (over: Partial<ClientView> = {}): ClientView => ({
  profile: profile(), disputes: [], invoices: [], usdFreeCents: 0, cryptoCents: { BTC: 0, ETH: 0 }, hasTrading: false, trading: 'none', withdrawals: 'open',
  recentWires: [], recentAch: [], eventsToday: 0, ...over,
});
const world = (c: ClientView, simDate = '2026-04-20'): WorldSnapshot => ({ simDate, clients: [c] });
const many = (s: WorldSnapshot, n = 400, c = cfg) => Array.from({ length: n }, (_, i) => chooseEvent(s, seeded(i + 1), c)).filter((e): e is PlannedEvent => !!e);
type Pay = Extract<PlannedEvent, { kind: 'pay' }>;
const pays = (events: PlannedEvent[]) => events.filter((e): e is Pay => e.kind === 'pay');

test('the same snapshot and seed always give the same event', () => {
  const s = world(client({ invoices: [invoice(1, '2026-04-01')], hasTrading: true, trading: 'open', usdFreeCents: 5_000_000, cryptoCents: { BTC: 9_000_000, ETH: 4_000_000 } }));
  assert.deepEqual(chooseEvent(s, seeded(7), cfg), chooseEvent(s, seeded(7), cfg));
  assert.ok(new Set(many(s, 50).map((e) => e.kind)).size > 1);
});

test('a client pays only what it is ready to pay: not before its time, never disputed or in flight invoices', () => {
  const future = world(client({ invoices: [invoice(1, '2026-05-30')] }));
  assert.equal(many(future).length, 0);
  const blocked = world(client({ invoices: [invoice(1, '2026-04-01', { disputed: true }), invoice(2, '2026-04-01', { inFlight: true })] }));
  assert.equal(many(blocked).length, 0);
  const due = world(client({ invoices: [invoice(1, '2026-04-01'), invoice(2, '2026-04-02', { amountCents: 250_000 })] }));
  const events = pays(many(due));
  assert.ok(events.length > 300);
  for (const e of events.filter((x) => x.mode === 'full')) {
    assert.deepEqual(e.invoiceIds, ['INV-1201', 'INV-1202']);
    assert.equal(e.amountCents, 1_250_000);
  }
});

test('the per-client daily cap holds', () => {
  const s = world(client({ invoices: [invoice(1, '2026-04-01')], eventsToday: 2 }));
  assert.equal(many(s).length, 0);
  assert.ok(many({ ...s, clients: [{ ...s.clients[0]!, eventsToday: 1 }] }).length > 0);
});

test('payment shapes: partial, overpaid, short on SWIFT, affiliate, ACH; each adds up', () => {
  const base = { invoices: [invoice(1, '2026-04-01'), invoice(2, '2026-04-02')] };
  const partial = pays(many(world(client({ ...base, profile: profile({ personality: 'partial', medianLate: 33 }) })))).filter((e) => e.mode === 'partial');
  assert.ok(partial.length > 100);
  for (const e of partial) {
    assert.deepEqual(e.invoiceIds, ['INV-1201']);
    assert.ok(e.amountCents >= 400_000 && e.amountCents <= 600_000);
  }
  const over = pays(many(world(client({ ...base, profile: profile({ overpays: true }) })))).filter((e) => e.mode === 'overpay');
  assert.ok(over.length > 20 && over.every((e) => e.amountCents === 2_100_000));
  const short = pays(many(world(client({ ...base, profile: profile({ international: true }) })))).filter((e) => e.mode === 'short');
  assert.ok(short.length > 50 && short.every((e) => e.chargesCents === 2500 && e.amountCents === 2_000_000 - 2500 && e.payer === 'client'));
  const aff = pays(many(world(client({ ...base, profile: profile({ affiliateKey: 'zephyr' }) })))).filter((e) => e.payer === 'affiliate');
  assert.ok(aff.length > 50 && aff.every((e) => e.mode === 'full' && e.rail === 'WIRE'));
  const ach = pays(many(world(client({ ...base, profile: profile({ rail: 'ACH' }) }))));
  assert.ok(ach.every((e) => e.rail === 'ACH'));
});

test('a delinquent client pays the oldest invoice in part, and so never catches up', () => {
  const s = world(client({ profile: profile({ personality: 'delinquent', medianLate: 25 }), invoices: [invoice(1, '2025-12-01'), invoice(2, '2026-01-01')] }));
  const events = pays(many(s));
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.equal(e.mode, 'partial');
    assert.deepEqual(e.invoiceIds, ['INV-1201']);
    assert.ok(e.amountCents < 1_000_000);
  }
});

test('a gamer pays only once the cure period is about to end', () => {
  const gamer = profile({ personality: 'gamer', medianLate: 20 });
  const invoices = [invoice(1, '2026-04-01')];
  assert.equal(many(world(client({ profile: gamer, invoices }))).length, 0);
  const running = client({ profile: gamer, invoices, cure: { state: 'running', dueOn: '2026-05-05' } });
  assert.equal(pays(many(world(running, '2026-05-02'))).length, 0);
  assert.ok(pays(many(world(running, '2026-05-04'))).length > 0);
  assert.ok(many(world(client({ profile: gamer, invoices, cure: { state: 'expired', dueOn: '2026-05-05' } }), '2026-05-10')).length > 0);
});

test('trades are small relative to holdings, within what the account can do', () => {
  const holdings = { hasTrading: true, trading: 'open' as const, usdFreeCents: 20_000_000, cryptoCents: { BTC: 80_000_000, ETH: 40_000_000 } };
  const trades = many(world(client(holdings))).filter((e) => e.kind === 'trade');
  assert.ok(trades.some((t) => t.side === 'buy') && trades.some((t) => t.side === 'sell'));
  for (const t of trades) {
    assert.ok(t.amountCents >= 100_000 && t.amountCents <= (t.side === 'buy' ? 25_000_000 : 30_000_000));
    assert.ok(t.amountCents <= (t.side === 'buy' ? holdings.usdFreeCents : holdings.cryptoCents[t.asset]) * 0.9);
  }
  // No cash: only sells. Nothing at all: no trade. No trading product: no trade.
  assert.ok(many(world(client({ ...holdings, usdFreeCents: 0 }))).every((e) => e.kind === 'trade' && e.side === 'sell'));
  assert.equal(many(world(client({ ...holdings, usdFreeCents: 0, cryptoCents: { BTC: 0, ETH: 0 } }))).filter((e) => e.kind === 'trade').length, 0);
  assert.equal(many(world(client({ ...holdings, hasTrading: false, trading: 'none' }))).filter((e) => e.kind === 'trade').length, 0);
});

test('with new positions paused a client mostly sells, and only now and then tries to buy (and is refused by the database)', () => {
  const s = world(client({ hasTrading: true, trading: 'limited', usdFreeCents: 20_000_000, cryptoCents: { BTC: 80_000_000, ETH: 40_000_000 } }));
  const trades = many(s, 600).filter((e) => e.kind === 'trade');
  const buys = trades.filter((t) => t.side === 'buy').length;
  assert.ok(buys > 0 && buys < trades.length * 0.3, `${buys} of ${trades.length}`);
});

test('withdrawals are a fraction of free custody cash; none when frozen or nearly empty', () => {
  const cash = { usdFreeCents: 40_000_000 };
  const out = many(world(client(cash))).filter((e) => e.kind === 'withdraw');
  assert.ok(out.length > 100 && out.every((e) => e.amountCents >= 500_000 && e.amountCents <= cash.usdFreeCents / 2));
  assert.equal(many(world(client({ ...cash, withdrawals: 'frozen' }))).length, 0);
  assert.equal(many(world(client({ usdFreeCents: 1_000_000 }))).length, 0);
});

test('duplicates repeat a paid wire once; ACH returns only follow an ACH debit', () => {
  const wire = { ref: 'WI-6001', amountCents: 1_000_000, chargesCents: 0, invoiceIds: ['INV-1201'], remittance: 'INV1201', payer: 'client' as const, duplicated: false };
  const dups = (c: ClientView) => many(world(c), 2000).filter((e) => e.kind === 'duplicate');
  assert.ok(dups(client({ recentWires: [wire] })).length > 0);
  assert.equal(dups(client({ recentWires: [{ ...wire, duplicated: true }] })).length, 0);
  assert.equal(dups(client({ recentWires: [wire], invoices: [invoice(1, '2026-05-30')] })).length, 0); // not actually paid
  // Against other things it could do, a habitual duplicator repeats itself more often.
  const busy = { hasTrading: true, trading: 'open' as const, usdFreeCents: 5_000_000, cryptoCents: { BTC: 9_000_000, ETH: 4_000_000 }, recentWires: [wire] };
  assert.ok(dups(client({ ...busy, profile: profile({ duplicates: true }) })).length > 3 * dups(client(busy)).length);
  const ach = { ref: 'AC-8001', amountCents: 1_000_000, invoiceIds: ['INV-1201'], returned: false };
  const returns = (c: ClientView) => many(world(c), 2000).filter((e) => e.kind === 'ach_return');
  assert.ok(returns(client({ recentAch: [ach] })).length > 0);
  assert.equal(returns(client({ recentAch: [{ ...ach, returned: true }] })).length, 0);
  assert.equal(returns(client({})).length, 0);
});

test('applying an event moves the snapshot on', () => {
  const s = world(client({ invoices: [invoice(1, '2026-04-01'), invoice(2, '2026-04-02')], hasTrading: true, trading: 'open', usdFreeCents: 5_000_000, cryptoCents: { BTC: 9_000_000, ETH: 0 } }));
  const pay = pays(many(s)).find((e) => e.mode === 'full')!;
  const after = applyEvent(s, pay, 1);
  assert.equal(after.clients[0]!.invoices.length, 0);
  assert.equal(after.clients[0]!.eventsToday, 1);
  assert.equal(s.clients[0]!.invoices.length, 2); // the input is untouched
  const buy = applyEvent(s, { kind: 'trade', clientId: 'ORG-X', side: 'buy', asset: 'BTC', amountCents: 1_000_000, why: '' }, 2);
  assert.deepEqual([buy.clients[0]!.usdFreeCents, buy.clients[0]!.cryptoCents.BTC], [4_000_000, 10_000_000]);
});

const dispute = (id = 'DSP-W0001', invoiceId = 'INV-1201', openedOn = '2026-04-05', amountCents = 1_000_000) => ({ id, invoiceId, openedOn, amountCents });
type Dispute = Extract<PlannedEvent, { kind: 'dispute' }>;
type Ruling = Extract<PlannedEvent, { kind: 'resolve_dispute' }>;
const disputes = (events: PlannedEvent[]) => events.filter((e): e is Dispute => e.kind === 'dispute');
const rulings = (events: PlannedEvent[]) => events.filter((e): e is Ruling => e.kind === 'resolve_dispute');

test('a serial disputer disputes an overdue invoice it would not yet pay, for the whole invoice and with a reason for the product', () => {
  const c = client({ profile: profile({ personality: 'disputer', medianLate: 32 }), invoices: [invoice(2, '2026-04-12'), invoice(1, '2026-04-10', { product: 'API' })] });
  const events = disputes(many(world(c)));
  assert.ok(events.length > 300);
  for (const e of events) {
    assert.equal(e.invoiceId, 'INV-1201'); // the oldest
    assert.equal(e.amountCents, 1_000_000);
    assert.ok(['API calls billed during the vendor outage', 'API overage double-counted'].includes(e.reason), e.reason);
  }
  // Not before it is overdue, and never what it is about to pay anyway.
  assert.equal(disputes(many(world(c, '2026-04-10'))).length, 0);
  assert.equal(disputes(many(world(c, '2026-06-30'))).length, 0); // ready to pay: it pays instead
  assert.equal(disputes(many(world(client({ ...c, invoices: [invoice(1, '2026-04-10', { paidCents: 1 })] })))).length, 0);
  assert.equal(disputes(many(world(client({ ...c, invoices: [invoice(1, '2026-04-10', { disputed: true })] })))).length, 0);
});

test('disputes stay a minority and never pile up: one per client, five in all', () => {
  const c = client({ profile: profile({ personality: 'disputer', medianLate: 32 }), invoices: [invoice(1, '2026-04-10')] });
  assert.equal(disputes(many(world({ ...c, disputes: [dispute()] }))).length, 0);
  const crowd = (open: number): WorldSnapshot => ({
    simDate: '2026-04-20',
    clients: [c, ...Array.from({ length: open }, (_, i) => client({ profile: profile({ clientId: `ORG-${i}` }), disputes: [dispute(`DSP-W${i}`, `INV-9${i}`)], invoices: [invoice(50 + i, '2026-04-10', { disputed: true })] }))],
  });
  assert.equal(disputes(many(crowd(5))).length, 0);
  assert.ok(disputes(many(crowd(4))).length > 0);
  // Among everything a busy platform does, they are rare.
  const busy = client({ hasTrading: true, trading: 'open', usdFreeCents: 5_000_000, cryptoCents: { BTC: 9_000_000, ETH: 4_000_000 } });
  const mix = many(world(busy), 400);
  assert.equal(disputes(mix).length, 0);
  const withDisputer = many({ simDate: '2026-04-20', clients: [{ ...busy, profile: profile({ personality: 'disputer', medianLate: 32 }), invoices: [invoice(1, '2026-04-10')] }] }, 1000);
  assert.ok(disputes(withDisputer).length > 0);
  const share = disputes(many({ simDate: '2026-04-20', clients: [{ ...busy, profile: profile({ personality: 'slow', medianLate: 10 }), invoices: [invoice(1, '2026-04-18')] }] }, 1000)).length;
  assert.ok(share < 100, `${share}`); // the occasional dispute from anyone else
});

test('a gamer disputes only in the last days of its cure period; a delinquent never; anyone else rarely and for part of the invoice', () => {
  const gamer = profile({ personality: 'gamer', medianLate: 20 });
  const invoices = [invoice(1, '2026-04-01')];
  const near = client({ profile: gamer, invoices, cure: { state: 'running', dueOn: '2026-05-05' } });
  assert.equal(disputes(many(world(near, '2026-04-25'))).length, 0);
  const inWindow = disputes(many(world(near, '2026-05-01')));
  assert.ok(inWindow.length > 100 && inWindow.every((e) => e.amountCents === 1_000_000));
  assert.equal(disputes(many(world(client({ ...near, cure: { state: 'expired', dueOn: '2026-05-05' } }), '2026-05-10'))).length, 0);
  assert.equal(disputes(many(world(client({ profile: profile({ personality: 'delinquent', medianLate: 25 }), invoices: [invoice(1, '2026-01-10')] })))).length, 0);
  const other = disputes(many(world(client({ profile: profile({ personality: 'slow', medianLate: 10 }), invoices: [invoice(1, '2026-04-18')] })), 2000));
  assert.ok(other.length > 0 && other.every((e) => e.amountCents >= 250_000 && e.amountCents <= 1_000_000 && e.amountCents % 1000 === 0));
});

test('a ruling comes when it is due: a disputer\'s just before it would have paid, and it is mostly turned down', () => {
  const p = profile({ personality: 'disputer', medianLate: 32 });
  const c = client({ profile: p, disputes: [dispute()], invoices: [invoice(1, '2026-04-01', { disputed: true })] });
  assert.equal(rulings(many(world(c, '2026-04-20'))).length, 0);
  const ruled = rulings(many(world(c, '2026-05-30')));
  assert.ok(ruled.length > 300 && ruled.every((e) => e.disputeId === 'DSP-W0001'));
  const credited = ruled.filter((e) => e.resolution === 'credited');
  assert.ok(credited.length > 0 && credited.length < ruled.length * 0.2, `${credited.length} of ${ruled.length}`);
  assert.ok(credited.every((e) => e.creditCents >= 150_000 && e.creditCents <= 600_000 && e.creditCents % 1000 === 0));
  assert.ok(ruled.filter((e) => e.resolution === 'no_change').every((e) => e.creditCents === 0));
});

test('anyone else is upheld about half the time, with a credit within what was disputed', () => {
  const c = client({ profile: profile({ personality: 'slow', medianLate: 10 }), disputes: [dispute('DSP-W0002', 'INV-1201', '2026-04-05', 300_000)], invoices: [invoice(1, '2026-04-01', { disputed: true, amountCents: 300_000 })] });
  const ruled = rulings(many(world(c, '2026-06-01')));
  const credited = ruled.filter((e) => e.resolution === 'credited');
  assert.ok(credited.length > ruled.length * 0.35 && credited.length < ruled.length * 0.65, `${credited.length} of ${ruled.length}`);
  assert.ok(credited.every((e) => e.creditCents >= 45_000 && e.creditCents <= 180_000));
});

test('applying a dispute marks the invoice; a credited ruling shrinks it, an upheld one reopens it', () => {
  const c = client({ profile: profile({ personality: 'disputer', medianLate: 32 }), invoices: [invoice(1, '2026-04-10')] });
  const s = world(c);
  const opened = applyEvent(s, { kind: 'dispute', clientId: 'ORG-X', invoiceId: 'INV-1201', amountCents: 1_000_000, reason: 'r', why: '' }, 1);
  assert.deepEqual([opened.clients[0]!.invoices[0]!.disputed, opened.clients[0]!.disputes.length], [true, 1]);
  const id = opened.clients[0]!.disputes[0]!.id;
  const upheld = applyEvent(opened, { kind: 'resolve_dispute', clientId: 'ORG-X', disputeId: id, invoiceId: 'INV-1201', resolution: 'no_change', creditCents: 0, why: '' }, 2);
  assert.deepEqual([upheld.clients[0]!.invoices[0]!.disputed, upheld.clients[0]!.invoices[0]!.amountCents, upheld.clients[0]!.disputes.length], [false, 1_000_000, 0]);
  const credit = applyEvent(opened, { kind: 'resolve_dispute', clientId: 'ORG-X', disputeId: id, invoiceId: 'INV-1201', resolution: 'credited', creditCents: 400_000, why: '' }, 2);
  assert.equal(credit.clients[0]!.invoices[0]!.amountCents, 600_000);
});
