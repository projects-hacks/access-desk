import type { Product } from '../domain';
import { AFFILIATES, CLIENTS } from './clients';
import { addDays, monthAfter } from './dates';
import { HISTORY_PERIODS, PRECEDENTS, historyPeriodsFor, payHistory, weeklyMetrics } from './history';
import { CASES, LOANS, LOAN_MOVEMENTS, UNKNOWN_WALLET_PAYMENT } from './scenario';
import type { BankMovement, Client, Dataset, Invoice, OnchainPayment, Party } from './types';

const SIM_DATE = '2026-03-03';
const BANK_WINDOW_START = '2026-02-01';
const PRODUCT_ORDER: Product[] = ['CUSTODY', 'TRADING', 'FINANCING', 'API'];
const LABELS: Record<Product, string> = {
  CUSTODY: 'Custody fees',
  TRADING: 'Trading fees',
  FINANCING: 'Financing interest',
  API: 'API usage',
};
const WIRE_FEE_CENTS = 1500;

/** Stable pseudo-random in [0, 1) so every build produces identical numbers. */
export function unit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** Monthly amount with a stable ±8% wobble, rounded to $10. */
function monthlyAmount(client: Client, product: Product, period: string): number {
  const base = client.monthly[product] ?? 0;
  const factor = 0.92 + unit(`${client.id}:${product}:${period}`) * 0.16;
  return toCents(Math.round((base * factor) / 10) * 10);
}

interface DraftInvoice extends Omit<Invoice, 'id'> {
  order: number;
}

function draftInvoices(): DraftInvoice[] {
  const drafts: DraftInvoice[] = [];
  CLIENTS.forEach((client, clientIndex) => {
    const periods = [...historyPeriodsFor(client), ...(client.olderOpenPeriods ?? []), '2026-01', '2026-02'];
    for (const period of periods) {
      const issuedOn = `${monthAfter(period)}-01`;
      const dueOn = addDays(issuedOn, client.termsDays);
      for (const product of PRODUCT_ORDER) {
        if (!client.products.includes(product)) continue;
        const override = period === '2026-01' ? client.janOverride?.[product] : undefined;
        drafts.push({
          order: clientIndex * 10 + PRODUCT_ORDER.indexOf(product),
          clientId: client.id,
          product,
          label: LABELS[product],
          period,
          issuedOn,
          dueOn,
          amountCents: override !== undefined ? toCents(override) : monthlyAmount(client, product, period),
          paidCents: 0,
          status: 'open',
        });
      }
      if (period === '2026-01') {
        for (const extra of client.extraJanInvoices ?? []) {
          drafts.push({
            order: clientIndex * 10 + 9,
            clientId: client.id,
            product: extra.product,
            label: extra.label,
            period,
            issuedOn,
            dueOn,
            amountCents: toCents(extra.amount),
            paidCents: 0,
            status: extra.disputed ? 'disputed' : 'open',
          });
        }
      }
    }
  });
  return drafts;
}

function numberInvoices(drafts: DraftInvoice[]): Invoice[] {
  return [...drafts]
    .sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.order - b.order)
    .map(({ order: _order, ...rest }, i) => ({ id: `INV-${1001 + i}`, ...rest }));
}

/** Movement ids are assigned per rail in date order after all movements exist. */
type DraftMovement = Omit<BankMovement, 'id'> & { fixedId?: string };

export function buildDataset(platform: Dataset['platform']): Dataset {
  const invoices = numberInvoices(draftInvoices());
  const historyCash = payHistory(CLIENTS, invoices.filter((i) => HISTORY_PERIODS.includes(i.period) && !isOlderOpen(i)), unit);
  const byClient = (id: string) => invoices.filter((i) => i.clientId === id);
  const janOf = (id: string) => byClient(id).filter((i) => i.period === '2026-01' && i.status !== 'disputed');
  const sum = (list: Invoice[]) => list.reduce((s, i) => s + i.amountCents, 0);
  const markApplied = (list: Invoice[], on: string) =>
    list.forEach((i) => ((i.paidCents = i.amountCents), (i.status = 'paid'), (i.paidOn = on)));
  /** Cash dated today or yesterday hasn't been applied yet: that's the overnight matching work. */
  const appliedBySimDate = (valueDate: string) => valueDate < addDays(SIM_DATE, -1);

  const drafts: DraftMovement[] = [];
  const onchain: OnchainPayment[] = [];
  const client = (id: string): Party => ({ type: 'client', id });

  for (const c of CLIENTS) {
    const jan = janOf(c.id);
    const refs = jan.map((i) => i.id);
    const dueOn = jan[0]?.dueOn ?? SIM_DATE;
    const b = c.jan;

    switch (b.kind) {
      case 'open':
        break;
      case 'paid':
      case 'paid_by_affiliate': {
        const valueDate = addDays(dueOn, b.daysFromDue);
        const party: Party = b.kind === 'paid' ? client(c.id) : { type: 'affiliate', key: b.affiliate };
        drafts.push({
          kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections', party,
          amountCents: sum(jan), valueDate, status: 'completed', refs,
          caseId: b.kind === 'paid_by_affiliate' ? 'affiliate-wire' : undefined,
        });
        if (appliedBySimDate(valueDate)) markApplied(jan, valueDate);
        break;
      }
      case 'overpaid': {
        const valueDate = addDays(dueOn, b.daysFromDue);
        drafts.push({
          kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections', party: client(c.id),
          amountCents: sum(jan) + b.extraCents, valueDate, status: 'completed', refs, caseId: 'overpayment',
        });
        break;
      }
      case 'duplicate_wire': {
        const valueDate = addDays(dueOn, b.daysFromDue);
        for (const date of [valueDate, addDays(valueDate, b.duplicateAfterDays)]) {
          drafts.push({
            kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections', party: client(c.id),
            amountCents: sum(jan), valueDate: date, status: 'completed', refs, caseId: 'duplicate-wire',
          });
        }
        // Billing applied the first wire; the second sits as unapplied cash.
        markApplied(jan, valueDate);
        break;
      }
      case 'wrong_reference': {
        const feb = byClient(c.id).filter((i) => i.period === '2026-02');
        drafts.push({
          kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections', party: client(c.id),
          amountCents: sum(jan), valueDate: addDays(dueOn, b.daysFromDue), status: 'completed',
          refs: feb.map((i) => i.id), caseId: 'wrong-reference',
        });
        break;
      }
      case 'new_bank_account':
        drafts.push({
          kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections',
          party: { type: 'client', id: c.id, account: 'secondary' },
          amountCents: sum(jan), valueDate: addDays(dueOn, b.daysFromDue), status: 'completed', refs,
          caseId: 'new-bank-account',
        });
        break;
      case 'short_paid':
        drafts.push({
          kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections', party: client(c.id),
          amountCents: sum(jan) - b.shortCents, valueDate: b.valueDate, status: 'completed', refs, caseId: 'short-wire',
        });
        break;
      case 'lump_sum_no_invoice_refs': {
        const open = byClient(c.id).filter((i) => i.period !== '2026-02' && i.status === 'open');
        drafts.push({
          kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections', party: client(c.id),
          amountCents: sum(open), valueDate: b.valueDate, status: 'completed', refs: [c.id], caseId: 'lump-sum',
        });
        break;
      }
      case 'no_reference':
        drafts.push({
          kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections', party: client(c.id),
          amountCents: sum(jan), valueDate: b.valueDate, status: 'completed', refs: [], memoName: b.memoName,
          caseId: 'no-reference',
        });
        break;
      case 'paid_not_applied':
        drafts.push({
          kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections', party: client(c.id),
          amountCents: sum(jan), valueDate: b.valueDate, status: 'completed', refs, caseId: 'paid-not-applied',
        });
        break;
      case 'partial': {
        const target = jan.find((i) => i.product === b.invoiceProduct);
        if (!target) throw new Error(`${c.id}: no January ${b.invoiceProduct} invoice for partial payment`);
        const amountCents = Math.round(target.amountCents * b.fraction);
        drafts.push({
          kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections', party: client(c.id),
          amountCents, valueDate: b.valueDate, status: 'completed', refs: [target.id], caseId: 'partial-payment',
        });
        target.paidCents = amountCents;
        break;
      }
      case 'in_transit':
        drafts.push({
          kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections', party: client(c.id),
          amountCents: sum(jan), valueDate: b.valueDate, status: 'pending', counterpartyStatus: 'completed', refs,
          caseId: 'in-transit',
        });
        break;
      case 'ach_returned': {
        drafts.push({
          kind: 'client_payment', rail: 'ACH', direction: 'in', platformAccount: 'collections', party: client(c.id),
          amountCents: sum(jan), valueDate: b.paidOn, status: 'completed', refs, caseId: 'ach-return',
        });
        drafts.push({
          kind: 'ach_return', rail: 'ACH', direction: 'out', platformAccount: 'collections', party: client(c.id),
          amountCents: sum(jan), valueDate: b.returnedOn, status: 'completed', refs, caseId: 'ach-return',
        });
        // Billing applied the ACH before it bounced; nobody reopened the invoice.
        markApplied(jan, b.paidOn);
        break;
      }
      case 'paid_onchain':
        onchain.push({
          txHash: `0x${Array.from({ length: 64 }, (_, i) => Math.floor(unit(`${c.id}:tx:${i}`) * 16).toString(16)).join('')}`,
          wallet: b.wallet, clientId: c.id, amountCents: sum(jan), asset: 'USDC', valueDate: b.valueDate, refs,
          caseId: 'onchain-payment',
        });
        break;
      case 'demo_affiliate_wire':
        drafts.push({
          fixedId: b.wireId,
          kind: 'client_payment', rail: 'WIRE', direction: 'in', platformAccount: 'collections',
          party: { type: 'affiliate', key: b.affiliate },
          // Paid per the portal's wire instructions: client id as reference, no invoice numbers.
          amountCents: sum(jan), valueDate: b.valueDate, status: 'pending', refs: [c.id], caseId: 'demo-affiliate-wire',
        });
        break;
    }
  }

  drafts.push(...LOAN_MOVEMENTS.map((m) => ({ ...m })));
  onchain.push(UNKNOWN_WALLET_PAYMENT);

  // Monthly bank fee: $15 per incoming wire posted in the month.
  const janWires = 26; // From the simulator's history (before the bank window): about one wire per client.
  const febWires = drafts.filter(
    (m) => m.direction === 'in' && m.rail === 'WIRE' && m.status === 'completed' && m.valueDate.startsWith('2026-02'),
  ).length;
  for (const [period, wires, date] of [
    ['2026-01', janWires, '2026-02-02'],
    ['2026-02', febWires, '2026-03-02'],
  ] as const) {
    drafts.push({
      fixedId: `BF-${period}`, kind: 'bank_fee', rail: 'BOOK', direction: 'out', platformAccount: 'collections',
      amountCents: wires * WIRE_FEE_CENTS, valueDate: date, status: 'completed', refs: [period],
    });
  }

  return {
    simDate: SIM_DATE,
    bankWindowStart: BANK_WINDOW_START,
    platform,
    clients: CLIENTS,
    affiliates: AFFILIATES,
    invoices,
    movements: assignMovementIds(drafts),
    onchain,
    loans: LOANS,
    cases: CASES,
    history: {
      start: '2025-03-01',
      cash: historyCash,
      precedents: PRECEDENTS,
      metrics: weeklyMetrics(SIM_DATE),
    },
  };
}

function isOlderOpen(i: Invoice): boolean {
  return CLIENTS.find((c) => c.id === i.clientId)?.olderOpenPeriods?.includes(i.period) ?? false;
}

function assignMovementIds(drafts: DraftMovement[]): BankMovement[] {
  const counters = { WIRE: 5401, ACH: 7101 };
  const reserved = new Set(drafts.map((d) => d.fixedId).filter(Boolean));
  const next = (rail: 'WIRE' | 'ACH') => {
    const prefix = rail === 'WIRE' ? 'WI' : 'AC';
    let id: string;
    do id = `${prefix}-${counters[rail]++}`;
    while (reserved.has(id));
    return id;
  };
  const sorted = [...drafts].sort((a, b) => a.valueDate.localeCompare(b.valueDate));
  const withIds = sorted.map(({ fixedId, ...m }) => ({
    ...m,
    id: fixedId ?? (m.rail === 'BOOK' ? `BK-${m.valueDate}` : next(m.rail)),
  }));
  // A return points at the payment it reverses.
  for (const ret of withIds.filter((m) => m.kind === 'ach_return')) {
    const original = withIds.find(
      (m) => m.kind === 'client_payment' && m.rail === 'ACH' && m.refs.join() === ret.refs.join(),
    );
    if (original) ret.reverses = original.id;
  }
  return withIds;
}
