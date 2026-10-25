import type { Dataset, Invoice, IsoDate } from '../dataset';
import { LABELS, PRODUCT_ORDER, monthlyAmount } from '../dataset/build';
import { addDays, monthAfter } from '../dataset/dates';

/** Most months billed in one run (a clock jumped far ahead catches up over a few ticks). */
const MAX_PERIODS_PER_RUN = 6;

const lastPeriod = (ds: Dataset) => ds.invoices.reduce((max, i) => (i.period > max ? i.period : max), '');

export const invoiceKey = (clientId: string, product: string, period: string) => `${clientId}|${product}|${period}`;

export const invoiceNumber = (id: string) => Number(id.replace(/^INV-/, ''));

/** Months whose invoices go out on or before `today` (usage for a month is billed on the 1st of the next), after the dataset's last. */
export function periodsDue(ds: Dataset, today: IsoDate): string[] {
  const out: string[] = [];
  for (let p = monthAfter(lastPeriod(ds)); `${monthAfter(p)}-01` <= today && out.length < MAX_PERIODS_PER_RUN; p = monthAfter(p)) out.push(p);
  return out;
}

/**
 * The invoices billing issues now: one per client and product for every month that has closed,
 * built like the dataset's (same monthly fee wobble, labels, due terms), numbered after the highest
 * existing number. Anything already issued (by client, product and period) is skipped, so a
 * restart mid-month, or two runs, never double-bills.
 */
export function invoicesToIssue(ds: Dataset, today: IsoDate, existing: { ids: Iterable<string>; keys: ReadonlySet<string> }): Invoice[] {
  let next = 1001;
  for (const id of existing.ids) next = Math.max(next, invoiceNumber(id) + 1);
  const out: Invoice[] = [];
  for (const period of periodsDue(ds, today)) {
    const issuedOn = `${monthAfter(period)}-01`;
    for (const client of ds.clients) {
      for (const product of PRODUCT_ORDER) {
        if (!client.products.includes(product) || existing.keys.has(invoiceKey(client.id, product, period))) continue;
        out.push({
          id: `INV-${next++}`, clientId: client.id, product, label: LABELS[product], period, issuedOn,
          dueOn: addDays(issuedOn, client.termsDays), amountCents: monthlyAmount(client, product, period), paidCents: 0, status: 'open',
        });
      }
    }
  }
  return out;
}
