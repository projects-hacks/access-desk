/**
 * Writes the credit analyst's test fixture: every client's book as it stands
 * on the sim date after a demo reset, before payment checking applies the
 * bank window. Same JSON shape as `python -m desk_agents.credit dump`.
 * Usage: pnpm credit:fixture
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../dataset';
import { clausesFor, contractFor, disputes, holdingsFor, owedToClient, renewalOn } from '../dataset/platform-data';
import type { Invoice } from '../dataset/types';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../agents/tests/fixtures/book.json');

const ds = loadDataset();
const payments = new Map<string, Array<{ value_on: string; amount_cents: number }>>();
const pay = (invoiceId: string, valueOn: string, amountCents: number) => {
  const list = payments.get(invoiceId) ?? [];
  list.push({ value_on: valueOn, amount_cents: amountCents });
  payments.set(invoiceId, list);
};

// History: billing applied each payment to the invoices it quotes, in order.
const invoices = new Map(ds.invoices.map((i) => [i.id, i]));
const allocated = new Map<string, number>();
for (const p of [...ds.history.cash].sort((a, b) => a.valueDate.localeCompare(b.valueDate))) {
  let left = p.amountCents;
  for (const ref of p.refs) {
    const inv = invoices.get(ref);
    if (!inv || left <= 0) continue;
    const amount = Math.min(inv.amountCents - (allocated.get(ref) ?? 0), left);
    if (amount <= 0) continue;
    allocated.set(ref, (allocated.get(ref) ?? 0) + amount);
    pay(ref, p.valueDate, amount);
    left -= amount;
  }
}

// Bank window: unapplied, except what billing had already applied in buildDataset.
const historyIds = new Set(allocated.keys());
for (const inv of ds.invoices) {
  if (historyIds.has(inv.id) || inv.paidCents <= 0) continue;
  const movement = ds.movements
    .filter((m) => m.direction === 'in' && m.kind === 'client_payment' && m.refs.includes(inv.id))
    .sort((a, b) => a.valueDate.localeCompare(b.valueDate))[0];
  const valueOn = inv.paidOn ?? movement?.valueDate;
  if (!valueOn) throw new Error(`${inv.id}: paid ${inv.paidCents} with no payment date`);
  pay(inv.id, valueOn, inv.paidCents);
}

const status = (i: Invoice) => (i.status === 'open' && i.paidCents > 0 ? 'partially_paid' : i.status);
const allDisputes = disputes(ds);
const owed = owedToClient(ds);

const books = ds.clients.map((c) => {
  const contract = contractFor(c);
  return {
    client: { id: c.id, name: c.name, segment: c.segment, tier: c.tier, strategic: !!c.strategic, renewal_on: renewalOn(c) ?? null },
    contract: {
      terms_days: contract.termsDays, grace_days: contract.graceDays, cure_days: contract.cureDays, cross_default: contract.crossDefault,
    },
    clauses: clausesFor(c).map((k) => ({ clause: k.clause, kind: k.kind, allowed: k.allowed })),
    invoices: ds.invoices
      .filter((i) => i.clientId === c.id)
      .map((i) => ({
        id: i.id, product: i.product, period: i.period, issued_on: i.issuedOn, due_on: i.dueOn, amount_cents: i.amountCents,
        paid_cents: i.paidCents, paid_on: i.paidOn ?? null, status: status(i), payments: payments.get(i.id) ?? [],
      })),
    disputes: allDisputes
      .filter((d) => d.clientId === c.id)
      .map((d) => ({
        id: d.id, invoice_id: d.invoiceId, opened_on: d.openedOn, resolved_on: d.resolvedOn ?? null, resolution: d.resolution, status: d.status,
      })),
    custody: holdingsFor(c).map((h) => ({ asset: h.asset, value_cents: h.valueCents })),
    owed_to_client_cents: owed.filter((o) => o.clientId === c.id).reduce((s, o) => s + o.amountCents, 0),
  };
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ today: ds.simDate, books }, null, 1)}\n`);
console.log(`${books.length} clients, ${ds.invoices.length} invoices -> ${OUT}`);
