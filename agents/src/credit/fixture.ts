/** The demo morning as data: 30 clients on 2026-03-03, the answer key the credit engine is tested against. */
import { readFileSync } from 'node:fs';
import { cut } from './load';
import { decide } from './tiers';
import { detect } from './detectors';
import { scoreBook, trailingBilling, type Billing } from './scoring';
import type { ClientBook, Flag, Scores, TierDecision } from './model';

type Raw = Record<string, any>;

function book(b: Raw, today: string): ClientBook {
  return {
    client: { id: b.client.id, name: b.client.name, segment: b.client.segment, tier: b.client.tier, strategic: b.client.strategic, renewalOn: b.client.renewal_on },
    contract: { termsDays: b.contract.terms_days, graceDays: b.contract.grace_days, cureDays: b.contract.cure_days, crossDefault: b.contract.cross_default },
    clauses: b.clauses,
    invoices: b.invoices.map((i: Raw) => ({
      id: i.id, product: i.product, period: i.period, issuedOn: i.issued_on, dueOn: i.due_on, amountCents: i.amount_cents, paidCents: i.paid_cents,
      paidOn: i.paid_on, status: i.status, payments: i.payments.map((p: Raw) => ({ valueOn: p.value_on, amountCents: p.amount_cents })),
    })),
    disputes: b.disputes.map((d: Raw) => ({ id: d.id, invoiceId: d.invoice_id, openedOn: d.opened_on, resolvedOn: d.resolved_on, resolution: d.resolution, status: d.status })),
    custody: b.custody.map((h: Raw) => ({ asset: h.asset, valueCents: h.value_cents })),
    owedToClientCents: b.owed_to_client_cents,
    today,
  };
}

/** The fixture's books, cut to `today` (default: the fixture's own date). */
export function loadFixture(today?: string): ClientBook[] {
  const data = JSON.parse(readFileSync(new URL('./fixtures/book.json', import.meta.url), 'utf8')) as Raw;
  return data.books.map((b: Raw) => cut(book(b, data.today), today ?? data.today));
}

export const billingOf = (books: ClientBook[]): Map<string, Billing> => new Map(books.map((b) => [b.client.id, trailingBilling(b)]));

export interface Verdict {
  book: ClientBook;
  scores: Scores;
  flags: Flag[];
  baseline: TierDecision;
}

/** Scores, detector flags and the rules' decision for every client. */
export function verdicts(books: ClientBook[]): Map<string, Verdict> {
  const billing = billingOf(books);
  return new Map(books.map((b) => {
    const scores = scoreBook(b, billing);
    const flags = detect(b);
    return [b.client.id, { book: b, scores, flags, baseline: decide(b, scores, flags) }];
  }));
}
