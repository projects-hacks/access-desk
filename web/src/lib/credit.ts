import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import type { Client, Invoice, Policy } from '../module_bindings/types';
import { daysBetween, useClientRows, type ClientRow } from './clients';
import { useClock } from './session';

/**
 * Seat 1, the credit analyst, computed in the browser from the clients' own history:
 * a value score, a reliability score, a percentile tier, and exploit patterns.
 * Where the credit agent has written its own profile (credit_profile), that wins.
 * The weights and tier rules come from the active `credit-model` / `credit-tiers`
 * policies, falling back to the vertical defaults below.
 */

export const DEFAULT_WEIGHTS = {
  value: { revenue: 0.6, monthly: 0.25, breadth: 0.15 },
  reliability: { onTime: 0.4, daysLate: 0.2, missed: 0.15, partials: 0.1, credibility: 0.15 },
};
export type Weights = typeof DEFAULT_WEIGHTS;

export const VALUE_DRIVERS = [
  { key: 'revenue', name: '12-month revenue' },
  { key: 'monthly', name: 'Average monthly bill' },
  { key: 'breadth', name: 'Product breadth' },
] as const;

export const RELIABILITY_DRIVERS = [
  { key: 'onTime', name: 'On-time payments' },
  { key: 'daysLate', name: 'Days late' },
  { key: 'missed', name: 'Missed payments' },
  { key: 'partials', name: 'Partial payments' },
  { key: 'credibility', name: 'Credibility signals' },
] as const;

/** The restriction ladder, gentlest first; a tier's ceiling is how far the agent may go alone. */
export const LADDER = [
  'Reminders',
  'Set-off from custody',
  'Prepaid only',
  'Withdrawals frozen',
  'Trading frozen',
] as const;

export type TierRule = {
  tier: number;
  name: string;
  /** Cumulative top percent of clients by score that land in this tier or above. */
  topPct: number;
  graceDays: number;
  /** Index into LADDER. */
  ceiling: number;
  /** Misses before new usage moves to prepay; 0 = never. */
  prepayAfter: number;
};

/** What works in institutional crypto; a company customizes from here. */
export const VERTICAL_TIERS: TierRule[] = [
  { tier: 1, name: 'Strategic', topPct: 5, graceDays: 45, ceiling: 0, prepayAfter: 0 },
  { tier: 2, name: 'Core', topPct: 25, graceDays: 30, ceiling: 3, prepayAfter: 3 },
  { tier: 3, name: 'Standard', topPct: 60, graceDays: 15, ceiling: 4, prepayAfter: 2 },
  { tier: 4, name: 'Watch', topPct: 85, graceDays: 7, ceiling: 4, prepayAfter: 1 },
  { tier: 5, name: 'Prepay', topPct: 100, graceDays: 0, ceiling: 4, prepayAfter: 1 },
];

export const PATTERNS = {
  seasonal: {
    name: 'Seasonal payer',
    blurb: 'Pays only a few months a year instead of monthly',
    rule: 'Payments land in 3 or fewer calendar months of 12, while invoices are issued in 8 or more.',
    fix: 'prepay',
    fixText: 'Move new usage to prepay',
    fixWhy: 'Removes the incentive to batch payments; the existing balance follows the ladder.',
  },
  last_minute: {
    name: 'Last-minute payer',
    blurb: 'Pays just before a restriction would land',
    rule: '3 or more invoices paid after the grace period but before the cure period ran out.',
    fix: 'shorter_grace',
    fixText: 'Halve the grace period for these clients',
    fixWhy: 'The cure period stops being free credit; paying on time costs them nothing.',
  },
  aging_reset: {
    name: 'Aging reset',
    blurb: 'Small partial payments to reset the aging clock',
    rule: '2 or more invoices paid in several partial amounts.',
    fix: 'aging_from_first_due',
    fixText: 'Age from the first due date, whatever was paid',
    fixWhy: 'A token payment no longer restarts the clock on the rest of the balance.',
  },
  entity_shuffle: {
    name: 'Entity shuffle',
    blurb: 'Pays from rotating affiliate entities',
    rule: '2 or more different affiliate or feeder entities pay for the same client.',
    fix: 'verified_payers_only',
    fixText: 'Accept payments only from verified payers',
    fixWhy: 'Each new paying entity has to be confirmed before it counts.',
  },
  dispute_to_delay: {
    name: 'Dispute-to-delay',
    blurb: 'Disputes invoices, then pays in full',
    rule: '3 or more disputes, most upheld or withdrawn, each followed by full payment.',
    fix: 'collect_after_dispute',
    fixText: 'Collect within 2 days of a dispute resolving, no new grace',
    fixWhy: 'A dispute pauses collection; it no longer buys a fresh grace period.',
  },
} as const;

export type PatternKey = keyof typeof PATTERNS;

export type Driver = { key: string; name: string; weight: number; value: number };

export type ScoredClient = {
  row: ClientRow;
  client: Client;
  value: number;
  reliability: number;
  score: number;
  /** True when the credit agent wrote this client's profile. */
  fromAgent: boolean;
  valueDrivers: Driver[];
  reliabilityDrivers: Driver[];
  /** Reliability, 0–100, for each of the last 6 months (oldest first). */
  trend: number[];
  /** Per month of the last 12 (oldest first): what happened to that month's invoices. */
  months: ('ontime' | 'late' | 'partial' | 'disputed' | 'open' | 'none')[];
  arCents: bigint;
  expectedLossCents: bigint;
  revenue12Cents: bigint;
  patterns: PatternKey[];
  suggestedTier: number;
};

const MONTHS = 12;
const ymOf = (date: string) => date.slice(0, 7);
function monthsBack(today: string, n: number): string[] {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(m.toISOString().slice(0, 7));
  }
  return out;
}
const clamp = (x: number) => Math.max(0, Math.min(1, x));

function activeRule<T>(policies: readonly Policy[], id: string): T | undefined {
  const p = policies.find((x) => x.policyId === id && x.status === 'active');
  if (!p) return;
  try {
    return JSON.parse(p.ruleJson) as T;
  } catch {
    return;
  }
}

/** The weights and tier rules in force, and any drafts waiting for approval. */
export function useCreditPolicy() {
  const [policies] = useTable(tables.policy);
  return useMemo(() => {
    const model = activeRule<{ weights?: Weights }>(policies, 'credit-model');
    const tiers = activeRule<{ tiers?: TierRule[] }>(policies, 'credit-tiers');
    const version = (id: string) =>
      Math.max(
        0,
        ...policies.filter((p) => p.policyId === id && p.status === 'active').map((p) => p.version),
      );
    return {
      weights: model?.weights ?? DEFAULT_WEIGHTS,
      tiers: tiers?.tiers?.length === 5 ? tiers.tiers : VERTICAL_TIERS,
      modelVersion: version('credit-model'),
      tiersVersion: version('credit-tiers'),
      drafts: policies.filter(
        (p) =>
          p.status === 'draft' &&
          (p.policyId.startsWith('credit-') || p.policyId.startsWith('exploit-fix-')),
      ),
      policies,
    };
  }, [policies]);
}

/** Tier for each score under percentile cutoffs (top 5% → T1 …). */
export function tierByPercentile(scores: number[], tiers: TierRule[]): (score: number) => number {
  const sorted = [...scores].sort((a, b) => b - a);
  const n = sorted.length || 1;
  // The lowest score that still makes each tier.
  const floors = tiers.map(
    (t) => sorted[Math.min(n - 1, Math.max(0, Math.ceil((t.topPct / 100) * n) - 1))] ?? 0,
  );
  return (score) => {
    for (let i = 0; i < tiers.length; i++) if (score >= floors[i]!) return tiers[i]!.tier;
    return tiers.at(-1)!.tier;
  };
}

/** Every client scored, with drivers, trend, patterns and the tier the scores suggest. */
export function useCreditBook(
  weights: Weights = DEFAULT_WEIGHTS,
  tierRules: TierRule[] = VERTICAL_TIERS,
) {
  const today = useClock()?.simDate ?? '';
  const rows = useClientRows();
  const [invoices, invoicesReady] = useTable(tables.invoice);
  const [disputes] = useTable(tables.dispute);
  const [applications, applicationsReady] = useTable(tables.paymentApplication);
  const [payers] = useTable(tables.payerIdentity);
  const [profiles] = useTable(tables.creditProfile);
  const [flags] = useTable(tables.exploitFlag);

  return useMemo(() => {
    // Scoring before the history has loaded would show every client as clean.
    if (!today || !rows.length || !invoicesReady || !applicationsReady) return [] as ScoredClient[];
    const window = monthsBack(today, MONTHS);
    const start = `${window[0]}-01`;
    const by = <T extends { clientId: string }>(xs: readonly T[]) => {
      const m = new Map<string, T[]>();
      for (const x of xs) (m.get(x.clientId) ?? m.set(x.clientId, []).get(x.clientId)!).push(x);
      return m;
    };
    const invBy = by(invoices);
    const dispBy = by(disputes);
    const payersBy = by(payers);
    const appsByInvoice = new Map<string, number>();
    for (const a of applications)
      if (!a.reversed) appsByInvoice.set(a.invoiceId, (appsByInvoice.get(a.invoiceId) ?? 0) + 1);

    // Revenue and bill size are percentile ranks across the book, so value spreads 0–100.
    const revenueOf = (inv: Invoice[]) =>
      inv
        .filter((i) => i.issuedOn >= start && i.status !== 'void')
        .reduce((s, i) => s + Number(i.amountCents), 0);
    const monthlyOf = (inv: Invoice[]) => {
      const own = inv.filter((i) => i.issuedOn >= start && i.status !== 'void');
      return revenueOf(inv) / (new Set(own.map((i) => ymOf(i.issuedOn))).size || 1);
    };
    const rankOf = (all: number[]) => {
      const sorted = [...all].sort((a, b) => a - b);
      return (v: number) => (v > 0 && sorted.length > 1 ? sorted.indexOf(v) / (sorted.length - 1) : 0);
    };
    const revenueRank = rankOf(rows.map((r) => revenueOf(invBy.get(r.client.id) ?? [])));
    const monthlyRank = rankOf(rows.map((r) => monthlyOf(invBy.get(r.client.id) ?? [])));

    const scored = rows.map((row): Omit<ScoredClient, 'suggestedTier'> => {
      const c = row.client;
      const inv = (invBy.get(c.id) ?? []).filter((i) => i.status !== 'void' && i.issuedOn >= start);
      const due = inv.filter((i) => i.dueOn < today);
      const paid = due.filter((i) => i.paidOn);
      const onTime = paid.filter((i) => i.paidOn! <= i.dueOn).length;
      const lateDays = due.map((i) => Math.max(0, daysBetween(i.dueOn, i.paidOn ?? today)));
      const avgLate = lateDays.length ? lateDays.reduce((s, d) => s + d, 0) / lateDays.length : 0;
      const missed = due.filter(
        (i) => !i.paidOn && i.status !== 'disputed' && daysBetween(i.dueOn, today) > 30,
      ).length;
      const partials = inv.filter(
        (i) => (appsByInvoice.get(i.id) ?? 0) > 1 || i.status === 'partially_paid',
      ).length;
      const disputesN = (dispBy.get(c.id) ?? []).length;

      const rel = {
        onTime: due.length ? onTime / due.length : 1,
        daysLate: 1 - clamp(avgLate / 45),
        missed: 1 - clamp(missed / 4),
        partials: 1 - clamp(partials / 4),
        credibility: 1 - clamp(disputesN / 5),
      };
      const revenue = revenueOf(invBy.get(c.id) ?? []);
      const billed = new Set(inv.map((i) => ymOf(i.issuedOn))).size || 1;
      const products = row.levers.filter((l) => l.state !== 'not_used').length;
      const val = {
        revenue: revenueRank(revenue),
        monthly: monthlyRank(monthlyOf(invBy.get(c.id) ?? [])),
        breadth: products / 4,
      };
      const profile = profiles.find((p) => p.clientId === c.id);
      const valueScore = profile
        ? profile.valueScore
        : Math.round(
            100 * VALUE_DRIVERS.reduce((s, d) => s + weights.value[d.key] * val[d.key], 0),
          );
      const reliabilityScore = profile
        ? profile.reliabilityScore
        : Math.round(
            100 *
              RELIABILITY_DRIVERS.reduce((s, d) => s + weights.reliability[d.key] * rel[d.key], 0),
          );

      const monthStatus = window.map((ym): ScoredClient['months'][number] => {
        const m = inv.filter((i) => ymOf(i.dueOn) === ym);
        if (!m.length) return 'none';
        if (
          m.some(
            (i) =>
              i.status === 'disputed' || (dispBy.get(c.id) ?? []).some((d) => d.invoiceId === i.id),
          )
        )
          return 'disputed';
        if (m.some((i) => (appsByInvoice.get(i.id) ?? 0) > 1 || i.status === 'partially_paid'))
          return 'partial';
        if (m.some((i) => !i.paidOn)) return ym < today.slice(0, 7) ? 'open' : 'none';
        return m.every((i) => i.paidOn! <= i.dueOn) ? 'ontime' : 'late';
      });
      const trend = window.slice(-6).map((ym) => {
        const m = inv.filter((i) => ymOf(i.dueOn) <= ym && i.dueOn < today);
        if (!m.length) return reliabilityScore;
        const ok = m.filter((i) => i.paidOn && i.paidOn <= i.dueOn).length / m.length;
        return Math.round(100 * (0.6 * ok + 0.4 * (reliabilityScore / 100)));
      });

      // Patterns: the agent's flags first, then the in-app detectors.
      const patterns = new Set<PatternKey>(
        (
          flags
            .filter((f) => f.clientId === c.id && f.status !== 'cleared')
            .map((f) => f.pattern) as string[]
        ).filter((p): p is PatternKey => p in PATTERNS),
      );
      const paidMonths = new Set(paid.map((i) => ymOf(i.paidOn!))).size;
      if (billed >= 8 && paidMonths > 0 && paidMonths <= 3) patterns.add('seasonal');
      const grace = row.contract?.graceDays ?? 0;
      const cure = row.contract?.cureDays ?? 0;
      const lastMinute = paid.filter((i) => {
        const late = daysBetween(i.dueOn, i.paidOn!);
        return late > grace && late <= grace + cure;
      }).length;
      if (cure > 0 && lastMinute >= 3) patterns.add('last_minute');
      if (partials >= 2) patterns.add('aging_reset');
      if ((payersBy.get(c.id) ?? []).filter((p) => p.kind === 'affiliate').length >= 2)
        patterns.add('entity_shuffle');
      if (disputesN >= 3) patterns.add('dispute_to_delay');

      const ar = row.unpaidCents;
      return {
        row,
        client: c,
        value: valueScore,
        reliability: reliabilityScore,
        score: Math.round(0.5 * valueScore + 0.5 * reliabilityScore),
        fromAgent: !!profile,
        valueDrivers: VALUE_DRIVERS.map((d) => ({
          ...d,
          weight: weights.value[d.key],
          value: val[d.key],
        })),
        reliabilityDrivers: RELIABILITY_DRIVERS.map((d) => ({
          ...d,
          weight: weights.reliability[d.key],
          value: rel[d.key],
        })),
        trend,
        months: monthStatus,
        arCents: ar,
        // Expected loss = AR × (1 − reliability) × 50% loss given default.
        expectedLossCents: (ar * BigInt(100 - reliabilityScore)) / 200n,
        revenue12Cents: BigInt(revenue),
        patterns: [...patterns],
      };
    });

    const tierOf = tierByPercentile(
      scored.map((s) => s.score),
      tierRules,
    );
    return scored.map((s) => ({ ...s, suggestedTier: s.client.strategic ? 1 : tierOf(s.score) }));
  }, [today, rows, invoices, invoicesReady, disputes, applications, applicationsReady, payers, profiles, flags, weights, tierRules]);
}

export function tierName(tier: number, rules: TierRule[] = VERTICAL_TIERS): string {
  return rules.find((t) => t.tier === tier)?.name ?? `Tier ${tier}`;
}
