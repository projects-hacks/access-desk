import { addDays } from './dates';
import type { Client, HistoryDispute, HistoryPayment, Invoice, IsoDate, MetricSnapshot, Precedent } from './types';

/**
 * Twelve months of history before the bank window: every invoice paid, with
 * payment timing that carries each client's real pattern. Exploit detection,
 * policy replay and the scoreboard read this.
 */

export const HISTORY_PERIODS = [
  '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07',
  '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
];
/** History cash must land before Nessie's window opens. */
const LAST_HISTORY_DAY = '2026-01-31';

/** Typical days after the due date, by tier. */
const TIER_OFFSET: Record<number, number> = { 1: -2, 2: 0, 3: 3, 4: 12, 5: 25 };

type Pattern = 'restriction_eve' | 'partial_reset' | 'pays_restricted_only' | 'quarter_end' | 'recent_late' | 'dispute_delay';

/** Patterns the exploit sub-agent should find. Each is real in the payment data below. */
export const PATTERNS: Record<string, { pattern: Pattern; description: string }> = {
  'ORG-90677': { pattern: 'restriction_eve', description: 'Pays the day before every day-21 restriction' },
  'ORG-90744': { pattern: 'partial_reset', description: 'Partial payments reset aging' },
  'ORG-90758': { pattern: 'pays_restricted_only', description: 'Pays the restricted product (API) fast, custody late' },
  'ORG-90101': { pattern: 'quarter_end', description: 'Pays only at quarter end' },
  'ORG-90412': { pattern: 'recent_late', description: 'Paid late 3 times in the last 90 days, always within 30' },
  'ORG-90518': { pattern: 'dispute_delay', description: 'Disputes every invoice; each is resolved with no change and paid in full two days later' },
};

/** Payment dates fixed by a precedent's outcome ("paid in 4 days"). */
const FIXED_PAYMENTS: Array<{ clientId: string; period: string; paidOn: IsoDate }> = [
  { clientId: 'ORG-90229', period: '2025-08', paidOn: '2025-10-18' },
  { clientId: 'ORG-90302', period: '2025-10', paidOn: '2025-12-14' },
  { clientId: 'ORG-90455', period: '2025-10', paidOn: '2025-12-01' },
  { clientId: 'ORG-90463', period: '2025-11', paidOn: '2026-01-21' },
  { clientId: 'ORG-90176', period: '2025-10', paidOn: '2025-12-24' },
];

export function historyPeriodsFor(client: Client): string[] {
  return HISTORY_PERIODS.filter((p) => !(client.olderOpenPeriods ?? []).includes(p));
}

const clamp = (date: IsoDate) => (date > LAST_HISTORY_DAY ? LAST_HISTORY_DAY : date);

/** A serial disputer: disputes four days after due, resolved with no change four weeks later, pays two days after that. */
function disputeWindow(clientId: string, period: string, due: IsoDate, unit: (seed: string) => number) {
  const resolvedOn = addDays(due, 27 + Math.round(unit(`${clientId}:${period}:dispute`) * 4));
  // The last window is squeezed so history still ends on its last day.
  if (addDays(resolvedOn, 2) > LAST_HISTORY_DAY) return { openedOn: addDays(due, 4), resolvedOn: addDays(LAST_HISTORY_DAY, -2), paidOn: LAST_HISTORY_DAY };
  return { openedOn: addDays(due, 4), resolvedOn, paidOn: addDays(resolvedOn, 2) };
}

const DISPUTE_REASONS = [
  'Custody fee charged on assets moved out mid-month',
  'API calls billed during the vendor outage',
  'Volume tier discount not applied',
  'Custody fee billed twice for the same period',
];

/** Every dispute the serial disputer raised in the history window; all resolved with no change. */
export function historyDisputes(clients: Client[], invoices: Invoice[], unit: (seed: string) => number): HistoryDispute[] {
  const out: HistoryDispute[] = [];
  for (const c of clients.filter((x) => PATTERNS[x.id]?.pattern === 'dispute_delay')) {
    historyPeriodsFor(c).forEach((period, n) => {
      const list = invoices.filter((i) => i.clientId === c.id && i.period === period);
      if (!list.length) return;
      const w = disputeWindow(c.id, period, list[0]!.dueOn, unit);
      for (const i of list) {
        out.push({
          id: `DSP-H${i.id.slice(4)}`, invoiceId: i.id, clientId: c.id, amountCents: i.amountCents,
          reason: DISPUTE_REASONS[n % DISPUTE_REASONS.length]!, openedOn: w.openedOn, resolvedOn: w.resolvedOn, resolution: 'no_change',
        });
      }
    });
  }
  return out;
}
const QUARTER_ENDS = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'];

interface PaymentDraft {
  clientId: string;
  valueDate: IsoDate;
  allocations: Array<{ invoice: Invoice; amountCents: number }>;
}

/**
 * Pays every history invoice and returns the cash. Mutates the invoices'
 * paidCents, paidOn and status (billing applied all of it).
 */
export function payHistory(clients: Client[], invoices: Invoice[], unit: (seed: string) => number): HistoryPayment[] {
  const drafts: PaymentDraft[] = [];
  for (const c of clients) {
    const periods = historyPeriodsFor(c);
    const pattern = PATTERNS[c.id]?.pattern;
    for (const period of periods) {
      const list = invoices.filter((i) => i.clientId === c.id && i.period === period);
      if (!list.length) continue;
      const due = list[0]!.dueOn;
      const fixed = FIXED_PAYMENTS.find((f) => f.clientId === c.id && f.period === period);
      const jitter = Math.round(unit(`${c.id}:${period}:pay`) * 4) - 2;
      const all = (date: IsoDate) => drafts.push({ clientId: c.id, valueDate: clamp(date), allocations: list.map((i) => ({ invoice: i, amountCents: i.amountCents })) });

      if (fixed) {
        all(fixed.paidOn);
      } else if (pattern === 'restriction_eve') {
        all(addDays(due, 20));
      } else if (pattern === 'partial_reset') {
        for (const i of list) {
          const half = Math.round(i.amountCents / 2);
          drafts.push({ clientId: c.id, valueDate: clamp(addDays(due, 8)), allocations: [{ invoice: i, amountCents: half }] });
          drafts.push({ clientId: c.id, valueDate: clamp(addDays(due, 33)), allocations: [{ invoice: i, amountCents: i.amountCents - half }] });
        }
      } else if (pattern === 'pays_restricted_only') {
        for (const i of list) {
          const days = i.product === 'API' ? 2 : 30;
          drafts.push({ clientId: c.id, valueDate: clamp(addDays(due, days)), allocations: [{ invoice: i, amountCents: i.amountCents }] });
        }
      } else if (pattern === 'dispute_delay') {
        all(disputeWindow(c.id, period, due, unit).paidOn);
      } else if (pattern === 'quarter_end') {
        all(QUARTER_ENDS.find((q) => q >= due) ?? LAST_HISTORY_DAY);
      } else if (pattern === 'recent_late' && ['2025-10', '2025-11', '2025-12'].includes(period)) {
        all(addDays(due, { '2025-10': 12, '2025-11': 18, '2025-12': 9 }[period] ?? 0));
      } else if (pattern === 'recent_late') {
        all(addDays(due, Math.min(jitter, 1)));
      } else {
        all(addDays(due, (TIER_OFFSET[c.tier] ?? 0) + jitter));
      }
    }
  }

  // Quarter-end payers send one wire for everything due by then.
  const merged = new Map<string, PaymentDraft>();
  for (const d of drafts) {
    const key = PATTERNS[d.clientId]?.pattern === 'quarter_end' ? `${d.clientId}:${d.valueDate}` : `${d.clientId}:${d.valueDate}:${merged.size}`;
    const existing = merged.get(key);
    if (existing) existing.allocations.push(...d.allocations);
    else merged.set(key, { ...d, allocations: [...d.allocations] });
  }

  const ordered = [...merged.values()].sort((a, b) => a.valueDate.localeCompare(b.valueDate) || a.clientId.localeCompare(b.clientId));
  const counters = { WIRE: 1, ACH: 1, USDC: 1 };
  const prefix = { WIRE: 'WI-H', ACH: 'AC-H', USDC: 'TX-H' } as const;
  return ordered.map((d) => {
    const client = clients.find((c) => c.id === d.clientId)!;
    const rail: HistoryPayment['rail'] = client.jan.kind === 'ach_returned' ? 'ACH' : client.jan.kind === 'paid_onchain' ? 'USDC' : 'WIRE';
    for (const a of d.allocations) {
      a.invoice.paidCents += a.amountCents;
      if (a.invoice.paidCents >= a.invoice.amountCents) {
        a.invoice.status = 'paid';
        a.invoice.paidOn = d.valueDate;
      }
    }
    return {
      id: `${prefix[rail]}${String(counters[rail]++).padStart(4, '0')}`,
      clientId: d.clientId,
      rail,
      amountCents: d.allocations.reduce((s, a) => s + a.amountCents, 0),
      valueDate: d.valueDate,
      refs: [...new Set(d.allocations.map((a) => a.invoice.id))],
    };
  });
}

/**
 * Past decisions. The first four are the overrides behind pol-014
 * ("hold the amount only, keep trading open, near renewal").
 */
export const PRECEDENTS: Precedent[] = [
  {
    id: 'PRC-0001', clientId: 'ORG-90229', decidedOn: '2025-10-14', policyRef: 'pol-003',
    situation: 'Late 23 days, coverage 0.7×, renewal in 12 days', proposed: 'Hold amount owed + no new positions',
    decision: 'Hold amount owed only', overrideReason: 'Too strict for this tier', outcome: 'Paid in 4d · renewed',
  },
  {
    id: 'PRC-0002', clientId: 'ORG-90455', decidedOn: '2025-11-26', policyRef: 'pol-003',
    situation: 'Late 18 days, renewal in 9 days', proposed: 'Hold amount owed + no new positions',
    decision: 'Hold amount owed only', overrideReason: "Don't touch trading before renewal", outcome: 'Paid in 5d',
  },
  {
    id: 'PRC-0003', clientId: 'ORG-90302', decidedOn: '2025-12-11', policyRef: 'pol-003',
    situation: 'Late 20 days, renewal in 10 days', proposed: 'Hold amount owed + no new positions',
    decision: 'Hold amount owed only', overrideReason: 'Renewal in 10 days', outcome: 'Paid in 3d · renewed',
  },
  {
    id: 'PRC-0004', clientId: 'ORG-90176', decidedOn: '2025-12-15', policyRef: 'pol-003',
    situation: 'Late 24 days, no renewal due', proposed: 'No new positions',
    decision: 'No new positions', overrideReason: '', outcome: 'Paid in 9d',
  },
  {
    id: 'PRC-0005', clientId: 'ORG-90463', decidedOn: '2026-01-02', policyRef: 'pol-003',
    situation: 'Late 22 days', proposed: 'Hold amount owed + no new positions',
    decision: 'Hold amount owed + no new positions', overrideReason: '', outcome: 'Paid at day 41',
  },
  {
    id: 'PRC-0006', clientId: 'ORG-90233', decidedOn: '2025-11-20', policyRef: 'pol-005',
    situation: 'Fees 9 days late, custody cash available, debit clause signed', proposed: 'Debit fees from custody',
    decision: 'Debit fees from custody', overrideReason: '', outcome: 'Collected, no restriction',
  },
  {
    id: 'PRC-0007', clientId: 'ORG-90518', decidedOn: '2025-12-16', policyRef: 'pol-006',
    situation: 'Fees late, staking rewards owed to client', proposed: 'Net staking rewards against fees',
    decision: 'Net staking rewards against fees', overrideReason: '', outcome: 'Netted, remainder paid in 6d',
  },
  {
    id: 'PRC-0008', clientId: 'ORG-90802', decidedOn: '2025-12-20', policyRef: 'pol-003',
    situation: 'Late 34 days, repeated, tier 5', proposed: 'API read-only + no new borrowing',
    decision: 'API read-only + no new borrowing', overrideReason: '', outcome: 'Still unpaid',
  },
  {
    id: 'PRC-0009', clientId: 'ORG-90816', decidedOn: '2026-01-12', policyRef: 'pol-009',
    situation: 'Second payment more than 30 days late in 180 days', proposed: 'Move API usage to prepay',
    decision: 'Move API usage to prepay', overrideReason: '', outcome: 'Prepay active',
  },
  {
    id: 'PRC-0010', clientId: 'ORG-90731', decidedOn: '2026-01-25', policyRef: 'pol-003',
    situation: 'Late 25 days, coverage 0.1×', proposed: 'API read-only',
    decision: 'API read-only', overrideReason: '', outcome: 'Still unpaid',
  },
  {
    id: 'PRC-0011', clientId: 'ORG-90758', decidedOn: '2026-01-28', policyRef: 'pol-003',
    situation: 'Late 27 days, custody invoices only', proposed: 'API read-only',
    decision: 'API read-only', overrideReason: '', outcome: 'Still unpaid',
  },
  {
    id: 'PRC-0012', clientId: 'ORG-90677', decidedOn: '2025-09-22', policyRef: 'pol-003',
    situation: 'Day 21, restriction due', proposed: 'API rate limit',
    decision: 'Withdrawn', overrideReason: '', outcome: 'Paid on day 20, before the restriction applied',
  },
];

/** Weekly trend for the overview: the share of cases needing a person fell as policies were learned. */
export function weeklyMetrics(simDate: IsoDate): MetricSnapshot[] {
  const human = [38.0, 34.5, 30.2, 26.8, 22.1, 19.4, 15.8, 12.6, 10.1, 8.3, 6.4, 5.2];
  return human.flatMap((share, i) => {
    const weekEnding = addDays(simDate, -7 * (human.length - 1 - i));
    return [
      { id: `${weekEnding}:share_needing_human`, weekEnding, metric: 'share_needing_human', value: share },
      { id: `${weekEnding}:handled_automatically`, weekEnding, metric: 'handled_automatically', value: Math.round((100 - share) * 10) / 10 },
    ];
  });
}
