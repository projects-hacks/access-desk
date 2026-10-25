/**
 * Six exploit detectors, one per pattern planted in the history. Each returns its measured
 * number even when it doesn't fire, so the reasoning can say why a client was cleared.
 */
import { addDays, daysBetween } from './dates';
import type { ClientBook, Evidence, Flag, Invoice } from './model';
import { scoredInvoices } from './scoring';

/** Days after due when access may first be restricted: grace, the notice day, then cure. */
export const restrictionDay = (book: ClientBook) => book.contract.graceDays + 1 + book.contract.cureDays;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => sum(xs) / xs.length;
const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;
/** Python's `{x:g}` for the small whole-ish numbers here. */
const g = (n: number) => String(Number(n.toPrecision(6)));

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function paidInvoices(book: ClientBook): Invoice[] {
  return book.invoices
    .filter((i) => i.status === 'paid' && i.paidOn)
    .sort((a, b) => cmp(a.period, b.period) || cmp(a.id, b.id));
}

const lagOf = (i: Invoice) => daysBetween(i.dueOn, i.paidOn as string);

function ev(i: Invoice, note: string): Evidence {
  return { invoiceId: i.id, dueOn: i.dueOn, paidOn: i.paidOn, dpd: i.paidOn ? Math.max(0, lagOf(i)) : 0, note };
}

/** Evidence is kept only for a fired flag; the measured string always explains the result. */
function flag(pattern: string, fired: boolean, measured: string, evidence: Evidence[], score: number, fix: string, months: number): Flag {
  return { pattern, fired, measured, evidence: fired ? evidence : [], months, score: round(score, 3), proposedFix: fix };
}

/** Counter.most_common(1): the highest count, the first seen on a tie. */
function mostCommon(xs: number[]): [number, number] {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: [number, number] = [0, 0];
  for (const [k, v] of counts) if (v > best[1]) best = [k, v];
  return best;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** Single payments in the last 8 periods land on the same day after due, past grace. */
export function restrictionEve(book: ClientBook): Flag {
  const periods = uniq(scoredInvoices(book).map((s) => s.invoice.period)).sort(cmp).slice(-8);
  const single = paidInvoices(book).filter((i) => periods.includes(i.period) && i.payments.length === 1);
  const [day, hits] = mostCommon(single.map(lagOf));
  const share = single.length ? hits / single.length : 0;
  const grace = book.contract.graceDays;
  const fired = single.length >= 6 && share >= 0.85 && day > grace;
  const matching = single.filter((i) => lagOf(i) === day);
  return flag(
    'restriction_eve', fired,
    `${hits} of ${single.length} single-payment invoices paid on day ${day} (grace ${grace}, restriction day ${restrictionDay(book)})`,
    matching.map((i) => ev(i, `paid on day ${day}`)), share,
    'Auto Pay or prepay on the due date; shorter cure at renewal',
    new Set(matching.map((i) => i.period)).size,
  );
}

/** A small first payment, then the balance after the restriction day. */
export function partialReset(book: ClientBook): Flag {
  const limit = restrictionDay(book);
  const split = book.invoices.filter((i) => i.payments.length >= 2);
  const hits: { i: Invoice; first: number; last: number }[] = [];
  for (const i of split) {
    const first = i.payments[0];
    const last = i.payments[i.payments.length - 1];
    if (first && last && first.amountCents < 0.6 * i.amountCents && daysBetween(i.dueOn, last.valueOn) > limit) {
      hits.push({ i, first: daysBetween(i.dueOn, first.valueOn), last: daysBetween(i.dueOn, last.valueOn) });
    }
  }
  return flag(
    'partial_reset', hits.length >= 2,
    `${hits.length} invoices paid in pieces with the balance after restriction day ${limit}`,
    hits.map(({ i, first, last }) => ({
      invoiceId: i.id, dueOn: i.dueOn, paidOn: i.paidOn, dpd: last, note: `first payment day ${first}, balance day ${last} vs restriction day ${limit}`,
    })),
    split.length ? hits.length / split.length : 0,
    "Clause: a partial payment reduces the balance but doesn't stop the cure clock",
    new Set(hits.map(({ i }) => i.period)).size,
  );
}

/** One product paid fast, another paid late: the median lag differs by 15+ days. */
export function paysRestrictedOnly(book: ClientBook): Flag {
  const byProduct = new Map<string, Invoice[]>();
  for (const i of paidInvoices(book)) byProduct.set(i.product, [...(byProduct.get(i.product) ?? []), i]);
  const medians = new Map([...byProduct].map(([p, list]) => [p, median(list.map(lagOf))]));
  const grace = book.contract.graceDays;
  if (medians.size < 2) return flag('pays_restricted_only', false, 'one product paid', [], 0, '', 0);
  const ranked = [...medians.keys()].sort((a, b) => ((medians.get(a) as number) - (medians.get(b) as number)) || cmp(a, b));
  const fast = ranked[0] as string;
  const slow = ranked[ranked.length - 1] as string;
  const fastMedian = medians.get(fast) as number;
  const slowMedian = medians.get(slow) as number;
  const fired = slowMedian - fastMedian >= 15 && slowMedian > grace;
  const slowInvoices = byProduct.get(slow) as Invoice[];
  const slowLate = slowInvoices.filter((i) => lagOf(i) > grace);
  return flag(
    'pays_restricted_only', fired,
    `median lag ${fast} day ${g(fastMedian)}, ${slow} day ${g(slowMedian)} (grace ${grace})`,
    slowLate.map((i) => ev(i, `${slow} paid on day ${lagOf(i)}; ${fast} on day ${g(fastMedian)}`)),
    slowLate.length / slowInvoices.length,
    'Cross-default at renewal, so a late custody bill puts API in default too',
    new Set(slowLate.map((i) => i.period)).size,
  );
}

// The plan said 5; Halcyon's normal Feb 28 wire for January makes 6 (owner approved 6).
const QUARTER_END_MAX_DATES = 6;

/** Few payment dates in the last year, each covering 2+ months of invoices. */
export function quarterEnd(book: ClientBook): Flag {
  const start = addDays(book.today, -365);
  const dates = new Map<string, Set<string>>();
  const paidBy = new Map<string, Invoice[]>();
  for (const i of book.invoices) {
    for (const p of i.payments) {
      if (p.valueOn < start || p.valueOn > book.today) continue;
      dates.set(p.valueOn, (dates.get(p.valueOn) ?? new Set()).add(i.period));
      paidBy.set(p.valueOn, [...(paidBy.get(p.valueOn) ?? []), i]);
    }
  }
  const periods = new Set([...dates.values()].flatMap((ps) => [...ps]));
  const ratio = dates.size ? periods.size / dates.size : 0;
  const fired = dates.size >= 1 && dates.size <= QUARTER_END_MAX_DATES && ratio >= 2;
  return flag(
    'quarter_end', fired,
    `${dates.size} payment dates for ${periods.size} months of invoices in 12 months`,
    [...dates.keys()].sort(cmp).flatMap((d) => (paidBy.get(d) as Invoice[]).map((i) => ev(i, `paid ${d} with ${(dates.get(d) as Set<string>).size} months of invoices`))),
    Math.min(1, ratio / 3),
    'Strategic: controller review only, no automatic fix',
    periods.size,
  );
}

/** The last 3 paid months got worse than before: a trend, not a one-off. */
export function recentLate(book: ClientBook): Flag {
  const worst = new Map<string, [number, Invoice]>();
  for (const i of paidInvoices(book)) {
    const dpd = Math.max(0, lagOf(i));
    const w = worst.get(i.period);
    if (!w || dpd > w[0]) worst.set(i.period, [dpd, i]);
  }
  const ordered = [...worst.keys()].sort(cmp).map((p) => worst.get(p) as [number, Invoice]);
  const last3 = ordered.slice(-3);
  const prior = ordered.slice(0, -3);
  const late = last3.filter(([d]) => d > 5);
  const priorMean = prior.length ? mean(prior.map(([d]) => d)) : 0;
  const jump = last3.length && prior.length ? mean(last3.map(([d]) => d)) - priorMean : 0;
  const fired = last3.length === 3 && late.length >= 2 && jump >= 7;
  const renewal = book.client.renewalOn;
  return flag(
    'recent_late', fired,
    `last 3 months ${last3.map(([d]) => d).join(', ')} days late vs ${priorMean.toFixed(1)} before (+${jump.toFixed(1)})`,
    last3.map(([d, i]) => ev(i, `${i.period} paid ${d} days late`)),
    late.length / 3,
    `No upgrade; recheck at renewal${renewal ? ` on ${renewal}` : ''}`,
    last3.length,
  );
}

/** Most months disputed, disputes upheld, then paid within days of each ruling. */
export function disputeDelay(book: ClientBook): Flag {
  const scoredPeriods = new Set(scoredInvoices(book).map((s) => s.invoice.period));
  const byId = new Map(book.invoices.map((i) => [i.id, i]));
  // A dispute still under review takes its month out of scoring, so it isn't counted here either.
  const disputedPeriods = new Set(
    book.disputes.flatMap((d) => {
      const p = byId.get(d.invoiceId)?.period;
      return p !== undefined && scoredPeriods.has(p) ? [p] : [];
    }),
  );
  const resolved = book.disputes.filter((d) => d.status === 'resolved');
  const upheld = resolved.filter((d) => d.resolution === 'no_change');
  const prompt = resolved.filter((d) => {
    const i = byId.get(d.invoiceId);
    if (!d.resolvedOn || !i?.paidOn) return false;
    const lag = daysBetween(d.resolvedOn, i.paidOn);
    return lag >= 0 && lag <= 3;
  });
  const monthShare = scoredPeriods.size ? disputedPeriods.size / scoredPeriods.size : 0;
  const upheldShare = resolved.length ? upheld.length / resolved.length : 0;
  const promptShare = resolved.length ? prompt.length / resolved.length : 0;
  const fired = monthShare >= 0.5 && upheldShare >= 0.8 && promptShare >= 0.8;
  return flag(
    'dispute_delay', fired,
    `${disputedPeriods.size} of ${scoredPeriods.size} months disputed, ${upheld.length} of ${resolved.length} upheld, ${prompt.length} paid within 3 days of the ruling`,
    prompt.map((d) => ev(byId.get(d.invoiceId) as Invoice, `disputed ${d.openedOn}, upheld ${d.resolvedOn}`)),
    Math.min(monthShare, upheldShare, promptShare),
    "Escalate; disputes filed after a default notice don't stop the cure period",
    disputedPeriods.size,
  );
}

export const DETECTORS: Record<string, (book: ClientBook) => Flag> = {
  restriction_eve: restrictionEve,
  partial_reset: partialReset,
  pays_restricted_only: paysRestrictedOnly,
  quarter_end: quarterEnd,
  recent_late: recentLate,
  dispute_delay: disputeDelay,
};

/** Every detector's result, fired or not. */
export const detect = (book: ClientBook): Flag[] => Object.values(DETECTORS).map((d) => d(book));
