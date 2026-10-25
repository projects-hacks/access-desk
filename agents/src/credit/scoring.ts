/**
 * Reliability, value, coverage and the expected settle date. Pure functions over ClientBooks;
 * every score keeps its breakdown so the reasoning can quote it.
 */
import { addDays, daysBetween, maxDate } from './dates';
import { clauseOf, openDisputeInvoiceIds, type ClientBook, type Invoice, type Scores } from './model';

const HALF_LIFE_DAYS = 90;
const NEUTRAL = 70;
const PRIOR_PERIODS = 3;
const PRODUCTS = 4;

/** An invoice past its due date that counts toward reliability. */
export interface Scored {
  invoice: Invoice;
  paid: boolean;
  lag: number;
  age: number;
  weight: number;
  dpd: number;
}

/** Past due, not void, not under an open dispute. Paid: lag to paid_on; open: lag to today. */
export function scoredInvoices(book: ClientBook): Scored[] {
  const disputed = openDisputeInvoiceIds(book);
  const out: Scored[] = [];
  for (const inv of book.invoices) {
    if (inv.dueOn >= book.today || inv.status === 'void' || disputed.has(inv.id)) continue;
    const paid = inv.status === 'paid' && inv.paidOn !== null;
    const end = paid && inv.paidOn ? inv.paidOn : book.today;
    const age = daysBetween(inv.dueOn, book.today);
    const lag = daysBetween(inv.dueOn, end);
    out.push({ invoice: inv, paid, lag, age, weight: 0.5 ** (age / HALF_LIFE_DAYS), dpd: Math.max(0, lag) });
  }
  return out.sort((a, b) => (a.invoice.dueOn === b.invoice.dueOn ? cmp(a.invoice.id, b.invoice.id) : cmp(a.invoice.dueOn, b.invoice.dueOn)));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function reliability(book: ClientBook): { score: number; parts: Record<string, number> } {
  const rows = scoredInvoices(book);
  const total = sum(rows.map((s) => s.weight));
  const meanDpd = total ? sum(rows.map((s) => s.weight * s.dpd)) / total : 0;
  const lateShare = total ? sum(rows.filter((s) => s.dpd > 10).map((s) => s.weight)) / total : 0;
  const worst = Math.max(0, ...rows.filter((s) => s.age <= 180).map((s) => s.dpd));
  const piecesWeight = sum(rows.filter((s) => s.invoice.payments.length >= 2).map((s) => s.weight));
  const lost = book.disputes.filter((d) => d.status === 'resolved' && d.resolution === 'no_change').length;

  const lateness = Math.min(35, 0.8 * meanDpd);
  const frequency = 20 * lateShare;
  const severity = worst > 60 ? 15 : worst > 30 ? 8 : 0;
  const pieces = Math.min(10, 4 * piecesWeight);
  const disputes = Math.min(15, 1.5 * lost);
  const raw = Math.max(0, 100 - (lateness + frequency + severity + pieces + disputes));
  const m = new Set(rows.map((s) => s.invoice.period)).size;
  const score = (m * raw + PRIOR_PERIODS * NEUTRAL) / (m + PRIOR_PERIODS);
  return {
    score,
    parts: {
      weighted_mean_dpd: meanDpd, late_share: lateShare, worst_dpd_180d: worst, lateness, frequency, severity, pieces, disputes,
      disputes_lost: lost, raw, periods: m,
    },
  };
}

/** What one client billed over the 365 days to today: cents and distinct products. */
export interface Billing {
  billedCents: number;
  products: number;
}

export function trailingBilling(book: ClientBook): Billing {
  const start = addDays(book.today, -365);
  const recent = book.invoices.filter((i) => i.issuedOn >= start && i.issuedOn <= book.today);
  return { billedCents: sum(recent.map((i) => i.amountCents)), products: new Set(recent.map((i) => i.product)).size };
}

/** Log of fees billed, scaled from the smallest client (0) to the largest (1), plus product breadth. */
export function valueOf(clientId: string, all: Map<string, Billing>): { score: number; parts: Record<string, number> } {
  const logs = new Map<string, number>();
  for (const [id, b] of all) if (b.billedCents > 0) logs.set(id, Math.log(b.billedCents));
  const lo = Math.min(...logs.values());
  const hi = Math.max(...logs.values());
  const b = all.get(clientId) ?? { billedCents: 0, products: 0 };
  const log = logs.get(clientId);
  const scale = log !== undefined && hi > lo ? (log - lo) / (hi - lo) : 0;
  const size = 75 * scale;
  const breadth = (25 * b.products) / PRODUCTS;
  return { score: size + breadth, parts: { billed_12m_cents: b.billedCents, products: b.products, size, breadth } };
}

export function exposureCents(book: ClientBook): number {
  const disputed = openDisputeInvoiceIds(book);
  return sum(
    book.invoices.filter((i) => !['paid', 'void', 'disputed'].includes(i.status) && !disputed.has(i.id)).map((i) => i.amountCents - i.paidCents),
  );
}

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

/** (Debitable USD custody + owed to client) / undisputed unpaid amount. */
export function coverage(book: ClientBook): { ratio: number; detail: string; exposure: number } {
  const exposure = exposureCents(book);
  const debit = clauseOf(book, 'debit');
  const setOff = clauseOf(book, 'set_off');
  const usdCustody = sum(book.custody.filter((h) => h.asset === 'USD').map((h) => h.valueCents));
  const debitable = debit?.allowed ? usdCustody : 0;
  const ratio = exposure ? (debitable + book.owedToClientCents) / exposure : 0;

  const holdable = setOff?.allowed ? sum(book.custody.map((h) => h.valueCents)) : 0;
  const debitPart = debit?.allowed ? `Debitable ${usd(debitable)} under §${debit.clause}` : 'no §6.3 debit clause';
  const multiple = exposure ? `${(holdable / exposure).toFixed(1)}x exposure` : 'no exposure';
  const holdPart = setOff?.allowed ? `holdable custody ${usd(holdable)} under §${setOff.clause} = ${multiple}` : 'no §7.2 set-off clause';
  return { ratio, detail: `${debitPart}; ${holdPart}; owed to client ${usd(book.owedToClientCents)}.`, exposure };
}

export function weightedMedian(pairs: [number, number][]): number | undefined {
  if (!pairs.length) return undefined;
  const sorted = [...pairs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = sum(sorted.map(([, w]) => w)) / 2;
  let running = 0;
  for (const [value, w] of sorted) {
    running += w;
    if (running >= half) return value;
  }
  return sorted[sorted.length - 1]?.[0];
}

/** Due date of the oldest open undisputed invoice + the recency-weighted median lag. */
export function expectedSettleOn(book: ClientBook): { settle: string | null; lag: number | undefined } {
  const lag = weightedMedian(scoredInvoices(book).filter((s) => s.paid).map((s) => [s.lag, s.weight]));
  const disputed = openDisputeInvoiceIds(book);
  const open = book.invoices.filter((i) => !['paid', 'void', 'disputed'].includes(i.status) && !disputed.has(i.id));
  const oldest = open.sort((a, b) => cmp(a.dueOn, b.dueOn) || cmp(a.id, b.id))[0];
  if (!oldest) return { settle: null, lag };
  return { settle: maxDate(addDays(oldest.dueOn, lag ?? 0), book.today), lag };
}

/** Every score for one client; `billing` covers all clients (value is relative to them). */
export function scoreBook(book: ClientBook, billing: Map<string, Billing>): Scores {
  const rel = reliability(book);
  const val = valueOf(book.client.id, billing);
  const cov = coverage(book);
  const { settle, lag } = expectedSettleOn(book);
  return {
    clientId: book.client.id,
    reliability: rel.score,
    value: val.score,
    coverageRatio: cov.ratio,
    coverageDetail: cov.detail,
    exposureCents: cov.exposure,
    expectedSettleOn: settle,
    breakdown: { ...rel.parts, ...val.parts, median_lag: lag ?? 0 },
  };
}

/** Whole 0-100 score, rounding halves to the even number like the Python it replaces. */
export function wholeScore(x: number): number {
  const r = Math.round(x);
  const even = Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  return Math.max(0, Math.min(100, even));
}
