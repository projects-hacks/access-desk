import type { IsoDate } from '../dataset';
import { addDays, daysBetween } from '../dataset/dates';
import { readyOn, rulingOn, type CureView, type Profile } from './personality';

/**
 * What happens next on the platform, as a pure function of what the database shows and a random
 * number source. The engine feeds it a snapshot read from SpacetimeDB; the dry run feeds it the
 * same snapshot and applies each event to it to show the next several.
 */
export type Rng = () => number;

/** mulberry32: a small seeded generator, so tests and plans are reproducible. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const formatUsd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type Asset = 'BTC' | 'ETH';

export interface InvoiceView {
  id: string;
  product: string;
  dueOn: IsoDate;
  amountCents: number;
  paidCents: number;
  disputed: boolean;
  /** A payment quoting it is on its way (not yet matched), so it must not be paid again. */
  inFlight: boolean;
}

/** A recent payment from the world that fully paid its invoices: what a duplicate would repeat. */
export interface RecentWire {
  ref: string;
  amountCents: number;
  chargesCents: number;
  invoiceIds: string[];
  remittance: string;
  payer: 'client' | 'affiliate';
  duplicated: boolean;
}

export interface RecentAch {
  ref: string;
  amountCents: number;
  invoiceIds: string[];
  returned: boolean;
}

/** A dispute under review at billing. */
export interface DisputeView {
  id: string;
  invoiceId: string;
  openedOn: IsoDate;
  amountCents: number;
}

export interface ClientView {
  profile: Profile;
  /** Everything under review, the dataset's own included: they all count against the cap. */
  disputes: DisputeView[];
  invoices: InvoiceView[];
  cure?: CureView;
  /** Custody cash not under a hold. */
  usdFreeCents: number;
  cryptoCents: Record<Asset, number>;
  hasTrading: boolean;
  trading: 'open' | 'limited' | 'off' | 'none';
  withdrawals: 'open' | 'frozen';
  recentWires: RecentWire[];
  recentAch: RecentAch[];
  eventsToday: number;
}

export interface WorldSnapshot {
  simDate: IsoDate;
  clients: ClientView[];
}

export type PayMode = 'full' | 'partial' | 'overpay' | 'short';

export type PlannedEvent =
  | {
    kind: 'pay'; clientId: string; rail: 'WIRE' | 'ACH'; payer: 'client' | 'affiliate'; invoiceIds: string[]; amountCents: number;
    mode: PayMode; reference: 'invoices' | 'client' | 'none'; chargesCents: number; typo: boolean; why: string;
  }
  | { kind: 'duplicate'; clientId: string; ref: string; why: string }
  | { kind: 'ach_return'; clientId: string; ref: string; why: string }
  | { kind: 'withdraw'; clientId: string; amountCents: number; why: string }
  | { kind: 'trade'; clientId: string; side: 'buy' | 'sell'; asset: Asset; amountCents: number; why: string }
  | { kind: 'dispute'; clientId: string; invoiceId: string; amountCents: number; reason: string; why: string }
  | { kind: 'resolve_dispute'; clientId: string; disputeId: string; invoiceId: string; resolution: 'no_change' | 'credited'; creditCents: number; why: string };

export interface ChooseConfig {
  /** At most this many events per client per sim day. */
  clientDayCap: number;
}

interface Candidate {
  weight: number;
  make: (rng: Rng) => PlannedEvent;
}

/** Relative odds. Payments dominate while something is due; the rest is background life. */
const WEIGHT = {
  pay: 20, trade: 1.2, withdraw: 0.35, duplicate: 0.08, duplicateHabit: 1, achReturn: 0.5, delinquent: 0.25,
  disputer: 1.2, gamerNearCure: 1.5, anyoneElse: 0.08, ruling: 12,
};

/** Disputes stay a minority: one under review per client, a handful across the platform. */
export const DISPUTES_PER_CLIENT = 1;
export const DISPUTES_IN_TOTAL = 5;
/** A gamer disputes in the last days of its cure period (a dispute filed in time stops the clock). */
const GAMER_WINDOW_DAYS = 6;

const REASONS: Record<string, string[]> = {
  CUSTODY: ['Custody fee charged on assets moved out mid-month', 'Custody fee billed twice for the same period'],
  TRADING: ['Volume tier discount not applied', 'Trading fees include an order that was cancelled'],
  API: ['API calls billed during the vendor outage', 'API overage double-counted'],
  FINANCING: ['Interest accrued after the repayment date', 'Rate does not match the term sheet'],
};

const SMALLEST_TRADE_CENTS = 100_000;
const LARGEST_BUY_CENTS = 25_000_000;
const LARGEST_SELL_CENTS = 30_000_000;
const roundTo = (cents: number, to: number) => Math.round(cents / to) * to;
const between = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);

const balance = (i: InvoiceView) => i.amountCents - i.paidCents;

function payCandidate(c: ClientView, today: IsoDate): Candidate | undefined {
  const p = c.profile;
  const ready = c.invoices
    .filter((i) => !i.disputed && !i.inFlight && balance(i) > 0)
    .flatMap((i) => {
      const on = readyOn(p, i, c.cure);
      return on !== undefined && on <= today ? [{ inv: i, on }] : [];
    })
    .sort((a, b) => a.inv.dueOn.localeCompare(b.inv.dueOn) || a.inv.id.localeCompare(b.inv.id));
  if (!ready.length) return undefined;
  const waited = Math.max(...ready.map((r) => daysBetween(r.on, today)));
  const weight = WEIGHT.pay * (1 + Math.min(2, waited / 4)) * (p.personality === 'delinquent' ? WEIGHT.delinquent : 1);
  return {
    weight,
    make: (rng) => {
      let invs = ready.slice(0, 6).map((r) => r.inv);
      const first = invs[0]!;
      const partialOdds = p.personality === 'delinquent' ? 1 : p.personality === 'partial' && first.paidCents === 0 ? 0.7 : 0.04;
      let mode: PayMode = 'full';
      let amountCents = 0;
      if (rng() < partialOdds && balance(first) >= 50_000) {
        mode = 'partial';
        invs = [first];
        amountCents = roundTo(balance(first) * between(rng, 0.4, 0.6), 100);
      } else {
        amountCents = invs.reduce((s, i) => s + balance(i), 0);
      }
      const payer = mode === 'full' && p.affiliateKey && rng() < (p.affiliateKey === 'basalt-feeder' ? 0.7 : 0.5) ? 'affiliate' : 'client';
      const rail = payer === 'client' && p.rail === 'ACH' ? 'ACH' : 'WIRE';
      let chargesCents = 0;
      if (mode === 'full' && p.overpays && rng() < 0.25) {
        mode = 'overpay';
        amountCents += 100_000;
      } else if (mode === 'full' && p.international && payer === 'client' && rail === 'WIRE' && rng() < 0.5) {
        // Sent in full from abroad; an intermediary bank takes its $25.00 on the way (SHA).
        mode = 'short';
        chargesCents = 2500;
        amountCents -= chargesCents;
      }
      const reference = payer === 'affiliate' ? (rng() < 0.5 ? 'client' : 'invoices')
        : p.reference === 'client' && invs.length < 3 ? 'invoices'
          : p.reference;
      const since = ready[0]!.on;
      return {
        kind: 'pay', clientId: p.clientId, rail, payer, invoiceIds: invs.map((i) => i.id), amountCents, mode, reference, chargesCents,
        typo: p.typos && rng() < 0.5, why: `${p.personality}: ${ready.length} invoice(s) ready since ${since}`,
      };
    },
  };
}

function tradeCandidate(c: ClientView): Candidate | undefined {
  if (!c.hasTrading || c.trading === 'none') return undefined;
  const sellable = (['BTC', 'ETH'] as const).filter((a) => c.cryptoCents[a] >= 2 * SMALLEST_TRADE_CENTS);
  const canBuy = c.usdFreeCents >= 2 * SMALLEST_TRADE_CENTS;
  if (!canBuy && !sellable.length) return undefined;
  return {
    weight: WEIGHT.trade * (c.trading === 'open' ? 1 : c.trading === 'limited' ? 0.5 : 0.1),
    make: (rng) => {
      const total = c.usdFreeCents + c.cryptoCents.BTC + c.cryptoCents.ETH;
      const usdShare = total > 0 ? c.usdFreeCents / total : 0;
      let sellOdds = !canBuy ? 1 : usdShare < 0.03 ? 0.85 : usdShare < 0.06 ? 0.55 : 0.4;
      // Paused or frozen trading: now and then a client tries to buy anyway, and the database refuses.
      if (c.trading !== 'open' && canBuy) sellOdds = sellable.length && rng() > 0.15 ? 1 : 0;
      if (!sellable.length) sellOdds = 0;
      if (rng() < sellOdds) {
        const asset = sellable[Math.floor(rng() * sellable.length)]!;
        const value = c.cryptoCents[asset];
        // Half a percent to four percent of the holding, spread evenly on a log scale: mostly small, rarely large.
        const pct = Math.exp(between(rng, Math.log(0.005), Math.log(0.04)));
        const amountCents = Math.min(LARGEST_SELL_CENTS, Math.max(SMALLEST_TRADE_CENTS, roundTo(value * pct, 1000)), Math.floor(value * 0.9));
        return { kind: 'trade', clientId: c.profile.clientId, side: 'sell', asset, amountCents, why: `custody holds ${formatUsd(value)} of ${asset}` };
      }
      const asset: Asset = rng() < 0.6 ? 'BTC' : 'ETH';
      const amountCents = Math.min(LARGEST_BUY_CENTS, Math.max(SMALLEST_TRADE_CENTS, roundTo(c.usdFreeCents * between(rng, 0.05, 0.2), 1000)), Math.floor(c.usdFreeCents * 0.9));
      return {
        kind: 'trade', clientId: c.profile.clientId, side: 'buy', asset, amountCents,
        why: c.trading === 'open' ? `${formatUsd(c.usdFreeCents)} of custody cash` : `tries to buy while trading is ${c.trading === 'limited' ? 'paused' : 'frozen'}`,
      };
    },
  };
}

function withdrawCandidate(c: ClientView): Candidate | undefined {
  if (c.withdrawals !== 'open' || c.usdFreeCents < 2_000_000) return undefined;
  const gaming = c.profile.personality === 'gamer' && c.cure?.state === 'running';
  return {
    weight: WEIGHT.withdraw * (gaming ? 8 : 1),
    make: (rng) => {
      const amountCents = Math.min(Math.floor(c.usdFreeCents / 2), Math.max(500_000, roundTo(c.usdFreeCents * between(rng, 0.02, 0.1), 10_000)));
      return { kind: 'withdraw', clientId: c.profile.clientId, amountCents, why: gaming ? 'cure period running: cash leaves before it ends' : `${formatUsd(c.usdFreeCents)} of custody cash` };
    },
  };
}

function disputeCandidate(c: ClientView, today: IsoDate): Candidate | undefined {
  const p = c.profile;
  if (c.disputes.length >= DISPUTES_PER_CLIENT) return undefined;
  const gamerNear = p.personality === 'gamer' && c.cure?.state === 'running' && daysBetween(today, c.cure.dueOn) <= GAMER_WINDOW_DAYS;
  const weight = p.personality === 'disputer' ? WEIGHT.disputer : gamerNear ? WEIGHT.gamerNearCure
    : p.personality === 'gamer' || p.personality === 'delinquent' ? 0 : WEIGHT.anyoneElse;
  if (!weight) return undefined;
  // Something unpaid and overdue that it would not pay right now: it disputes it instead.
  const eligible = c.invoices
    .filter((i) => !i.disputed && !i.inFlight && i.paidCents === 0 && i.dueOn < today)
    .filter((i) => {
      const on = readyOn(p, i, c.cure);
      return on === undefined || on > today;
    })
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id));
  const inv = eligible[0];
  if (!inv) return undefined;
  return {
    weight,
    make: (rng) => {
      const wholeInvoice = p.personality === 'disputer' || p.personality === 'gamer';
      const reasons = REASONS[inv.product] ?? REASONS.CUSTODY!;
      return {
        kind: 'dispute', clientId: p.clientId, invoiceId: inv.id, reason: reasons[Math.floor(rng() * reasons.length)]!,
        amountCents: wholeInvoice ? inv.amountCents : Math.min(inv.amountCents, Math.max(10_000, roundTo(inv.amountCents * between(rng, 0.25, 1), 1000))),
        why: gamerNear ? `cure period ends ${c.cure!.dueOn}: a dispute now stops the clock` : `${p.personality}: ${inv.id} is ${daysBetween(inv.dueOn, today)} days past due`,
      };
    },
  };
}

function rulingCandidates(c: ClientView, today: IsoDate): Candidate[] {
  const p = c.profile;
  return c.disputes.flatMap((d) => {
    const inv = c.invoices.find((i) => i.id === d.invoiceId);
    const due = inv ? rulingOn(p, inv, d.openedOn) : addDays(d.openedOn, 15);
    if (due > today) return [];
    return [{
      weight: WEIGHT.ruling,
      make: (rng) => {
        // Serial disputers and gamers are almost always turned down; anyone else is upheld half the time.
        const stands = p.personality === 'disputer' || p.personality === 'gamer' ? 0.1 : 0.5;
        const credited = rng() < stands;
        // A credit note covers 15-60% of what was disputed, to the $10.
        const creditCents = credited ? Math.min(d.amountCents, Math.max(10_000, roundTo(d.amountCents * between(rng, 0.15, 0.6), 1000))) : 0;
        return {
          kind: 'resolve_dispute' as const, clientId: p.clientId, disputeId: d.id, invoiceId: d.invoiceId,
          resolution: credited ? 'credited' as const : 'no_change' as const, creditCents,
          why: `${p.personality}: opened ${d.openedOn}, ruling due ${due}`,
        };
      },
    }];
  });
}

/** One event, or undefined when nothing is plausible right now. */
export function chooseEvent(s: WorldSnapshot, rng: Rng, cfg: ChooseConfig): PlannedEvent | undefined {
  const candidates: Candidate[] = [];
  const open = s.clients.reduce((n, c) => n + c.disputes.length, 0);
  for (const c of s.clients) {
    if (c.eventsToday >= cfg.clientDayCap) continue;
    const id = c.profile.clientId;
    const paid = (ids: string[]) => ids.every((i) => !c.invoices.some((v) => v.id === i && balance(v) > 0));
    const pay = payCandidate(c, s.simDate);
    if (pay) candidates.push(pay);
    for (const w of c.recentWires) {
      if (w.duplicated || !paid(w.invoiceIds)) continue;
      candidates.push({
        weight: c.profile.duplicates ? WEIGHT.duplicateHabit : WEIGHT.duplicate,
        make: () => ({ kind: 'duplicate', clientId: id, ref: w.ref, why: `sends ${w.ref} again (${w.payer})` }),
      });
    }
    for (const a of c.recentAch) {
      if (a.returned || !paid(a.invoiceIds)) continue;
      candidates.push({ weight: WEIGHT.achReturn, make: () => ({ kind: 'ach_return', clientId: id, ref: a.ref, why: `${a.ref} comes back R01, insufficient funds` }) });
    }
    for (const make of [withdrawCandidate(c), tradeCandidate(c)]) if (make) candidates.push(make);
    candidates.push(...rulingCandidates(c, s.simDate));
    const dispute = open < DISPUTES_IN_TOTAL ? disputeCandidate(c, s.simDate) : undefined;
    if (dispute) candidates.push(dispute);
  }
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  if (!(total > 0)) return undefined;
  let pick = rng() * total;
  for (const c of candidates) {
    pick -= c.weight;
    if (pick < 0) return c.make(rng);
  }
  return candidates.at(-1)!.make(rng);
}

/** A line for the log and the plan. */
export function describeEvent(e: PlannedEvent, name: string): string {
  switch (e.kind) {
    case 'pay': {
      const how = e.rail === 'ACH' ? 'ACH debit' : e.payer === 'affiliate' ? 'wire via its affiliate' : 'wire';
      const note = e.mode === 'partial' ? ' (partial)' : e.mode === 'overpay' ? ' (overpays $1,000.00)' : e.mode === 'short' ? ' (SWIFT, $25.00 charges)' : '';
      const what = e.reference === 'invoices' ? e.invoiceIds.join(' ') : e.reference === 'client' ? 'client id only' : 'no reference';
      return `${name} ${how} ${formatUsd(e.amountCents)}${note} for ${what}`;
    }
    case 'duplicate': return `${name} sends the wire ${e.ref} a second time`;
    case 'ach_return': return `${name}'s bank returns ACH ${e.ref} (R01)`;
    case 'withdraw': return `${name} withdraws ${formatUsd(e.amountCents)} from custody`;
    case 'trade': return `${name} ${e.side === 'buy' ? 'buys' : 'sells'} ${formatUsd(e.amountCents)} of ${e.asset}`;
    case 'dispute': return `${name} disputes ${e.invoiceId} (${formatUsd(e.amountCents)}): ${e.reason}`;
    case 'resolve_dispute': return e.resolution === 'credited'
      ? `billing rules for ${name} on ${e.disputeId} (${e.invoiceId}): credit note of ${formatUsd(e.creditCents)}`
      : `billing rules against ${name} on ${e.disputeId} (${e.invoiceId}): no change`;
  }
}

/** The snapshot as it would look after the event (dry run only; the engine re-reads the database). */
export function applyEvent(s: WorldSnapshot, e: PlannedEvent, n: number): WorldSnapshot {
  const next = structuredClone(s);
  const c = next.clients.find((x) => x.profile.clientId === e.clientId)!;
  c.eventsToday++;
  switch (e.kind) {
    case 'pay': {
      let rest = e.amountCents + e.chargesCents;
      for (const id of e.invoiceIds) {
        const inv = c.invoices.find((i) => i.id === id)!;
        const pay = Math.min(rest, balance(inv));
        inv.paidCents += pay;
        rest -= pay;
      }
      c.invoices = c.invoices.filter((i) => balance(i) > 0);
      const ref = `${e.rail === 'ACH' ? 'AC' : 'WI'}-plan${n}`;
      if (e.mode !== 'partial' && e.rail === 'WIRE') {
        c.recentWires.push({ ref, amountCents: e.amountCents, chargesCents: e.chargesCents, invoiceIds: e.invoiceIds, remittance: '', payer: e.payer, duplicated: false });
      } else if (e.rail === 'ACH') {
        c.recentAch.push({ ref, amountCents: e.amountCents, invoiceIds: e.invoiceIds, returned: false });
      }
      break;
    }
    case 'duplicate': c.recentWires.filter((w) => w.ref === e.ref).forEach((w) => (w.duplicated = true)); break;
    case 'ach_return': c.recentAch.filter((a) => a.ref === e.ref).forEach((a) => (a.returned = true)); break;
    case 'withdraw': c.usdFreeCents -= e.amountCents; break;
    case 'dispute': {
      c.invoices.filter((i) => i.id === e.invoiceId).forEach((i) => (i.disputed = true));
      c.disputes.push({ id: `DSP-plan${n}`, invoiceId: e.invoiceId, openedOn: s.simDate, amountCents: e.amountCents });
      break;
    }
    case 'resolve_dispute': {
      c.disputes = c.disputes.filter((d) => d.id !== e.disputeId);
      for (const i of c.invoices.filter((x) => x.id === e.invoiceId)) {
        i.disputed = false;
        i.amountCents -= e.creditCents;
      }
      c.invoices = c.invoices.filter((i) => balance(i) > 0);
      break;
    }
    case 'trade':
      c.usdFreeCents += e.side === 'buy' ? -e.amountCents : e.amountCents;
      c.cryptoCents[e.asset] += e.side === 'buy' ? e.amountCents : -e.amountCents;
      break;
  }
  return next;
}
