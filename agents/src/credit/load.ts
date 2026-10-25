import type { DbConnection } from '../module_bindings';
import { addDays } from './dates';
import type { Billing } from './scoring';
import type { ClientBook, Dispute, Invoice, Payment } from './model';

/**
 * A ClientBook for one client from the live cache, cut to `today` so nothing dated later is
 * ever read. Undefined for an unknown client.
 */
export function loadBook(conn: DbConnection, clientId: string, today: string): ClientBook | undefined {
  const c = conn.db.client.id.find(clientId);
  if (!c) return undefined;
  const k = conn.db.contract.clientId.find(clientId);
  const invoices: Invoice[] = [...conn.db.invoice.clientId.filter(clientId)].map((i) => ({
    id: i.id, product: i.product, period: i.period, issuedOn: i.issuedOn, dueOn: i.dueOn, amountCents: Number(i.amountCents),
    paidCents: Number(i.paidCents), paidOn: i.paidOn ?? null, status: i.status, payments: paymentsOf(conn, i.id, i.paidOn),
  }));
  return cut({
    client: { id: c.id, name: c.name, segment: c.segment, tier: c.tier, strategic: c.strategic, renewalOn: c.renewalOn ?? null },
    contract: k
      ? { termsDays: k.termsDays, graceDays: k.graceDays, cureDays: k.cureDays, crossDefault: k.crossDefault }
      : { termsDays: 30, graceDays: 5, cureDays: 10, crossDefault: false },
    clauses: [...conn.db.contractClause.clientId.filter(clientId)].map((x) => ({ clause: x.clause, kind: x.kind, allowed: x.allowed })),
    invoices,
    disputes: [...conn.db.dispute.clientId.filter(clientId)].map((d) => ({
      id: d.id, invoiceId: d.invoiceId, openedOn: d.openedOn, resolvedOn: d.resolvedOn ?? null, resolution: d.resolution, status: d.status,
    })),
    custody: [...conn.db.custodyHolding.clientId.filter(clientId)].map((h) => ({ asset: h.asset, valueCents: Number(h.valueCents) })),
    owedToClientCents: [...conn.db.owedToClient.clientId.filter(clientId)].reduce((sum, o) => sum + Number(o.amountCents), 0),
    today,
  }, today);
}

/** Several applications of one cash movement on one invoice are one payment. */
function paymentsOf(conn: DbConnection, invoiceId: string, paidOn: string | undefined): Payment[] {
  const byDate = new Map<string, number>();
  const applications = [...conn.db.paymentApplication.invoiceId.filter(invoiceId)].sort((a, b) => Number(a.id - b.id));
  for (const a of applications) {
    if (a.reversed) continue;
    // Custody debits have no cash movement; they settle on the invoice's paid date.
    const on = conn.db.cashMovement.id.find(a.movementId)?.valueOn || paidOn;
    if (on) byDate.set(on, (byDate.get(on) ?? 0) + Number(a.amountCents));
  }
  return [...byDate].sort(([a], [b]) => (a < b ? -1 : 1)).map(([valueOn, amountCents]) => ({ valueOn, amountCents }));
}

/** What every client billed in the 365 days to `today`: the value score is relative to the others. */
export function loadBilling(conn: DbConnection, today: string): Map<string, Billing> {
  const start = addDays(today, -365);
  const out = new Map<string, { cents: number; products: Set<string> }>();
  for (const c of conn.db.client.iter()) out.set(c.id, { cents: 0, products: new Set() });
  for (const i of conn.db.invoice.iter()) {
    const b = out.get(i.clientId);
    if (!b || i.issuedOn < start || i.issuedOn > today) continue;
    b.cents += Number(i.amountCents);
    b.products.add(i.product);
  }
  return new Map([...out].map(([id, b]) => [id, { billedCents: b.cents, products: b.products.size }]));
}

/** The book as it stood on `today`: later invoices, payments and dispute rulings removed. */
export function cut(book: ClientBook, today: string): ClientBook {
  const invoices: Invoice[] = [];
  for (const inv of book.invoices) {
    if (inv.issuedOn > today) continue;
    const payments = inv.payments.filter((p) => p.valueOn <= today);
    const dropped = inv.payments.filter((p) => p.valueOn > today).reduce((sum, p) => sum + p.amountCents, 0);
    const paidCents = Math.max(0, inv.paidCents - dropped);
    const paidOn = inv.paidOn && inv.paidOn <= today ? inv.paidOn : null;
    invoices.push({ ...inv, payments, paidCents, paidOn, status: statusOf(inv, paidCents, paidOn) });
  }
  const disputes: Dispute[] = [];
  for (const d of book.disputes) {
    if (d.openedOn > today) continue;
    disputes.push(d.resolvedOn && d.resolvedOn > today ? { id: d.id, invoiceId: d.invoiceId, openedOn: d.openedOn, resolvedOn: null, resolution: '', status: 'under_review' } : d);
  }
  // Only a dispute still open on `today` marks an unpaid invoice disputed.
  const disputed = new Set(disputes.filter((d) => d.status === 'under_review').map((d) => d.invoiceId));
  const marked = invoices.map((i) => (disputed.has(i.id) && i.status !== 'paid' ? { ...i, status: 'disputed' } : i));
  return { ...book, invoices: marked, disputes, today };
}

function statusOf(inv: Invoice, paidCents: number, paidOn: string | null): string {
  if (inv.status === 'void') return 'void';
  if (paidCents >= inv.amountCents && paidOn) return 'paid';
  return paidCents > 0 ? 'partially_paid' : 'open';
}
