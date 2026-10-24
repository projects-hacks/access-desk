/**
 * Payment matching: pure functions, no database access, so every rule is unit-testable.
 * Amounts are bigint cents.
 */

/** Short payments up to this amount are written off to bank fees (pol-002). */
export const SHORT_FEE_LIMIT_CENTS = 5_000n;
/** Largest number of open invoices searched for an exact combination. */
const MAX_SUBSET_SEARCH = 14;

export interface CandidateInvoice {
  id: string;
  dueOn: string;
  amountCents: bigint;
  /** What can still be paid: amount minus applied, plus billing-applied cash not yet tied to a movement. */
  balanceCents: bigint;
}

export type MatchMethod = 'referenced' | 'exact' | 'split' | 'short_fee' | 'overpaid' | 'partial';

export interface Allocation {
  invoiceId: string;
  amountCents: bigint;
}

export interface MatchPlan {
  method: MatchMethod;
  allocations: Allocation[];
  /** Covered by a write-off to bank fees. */
  shortCents: bigint;
  /** Held as credit on account. */
  excessCents: bigint;
  /** True when the plan used the payer's own references. */
  usedReferences: boolean;
  basis: string;
}

export type MatchResult =
  | { kind: 'plan'; plan: MatchPlan }
  /** Every referenced invoice is already fully paid by other cash. */
  | { kind: 'duplicate'; invoiceIds: string[] }
  | { kind: 'none'; reason: string };

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const byDue = (a: CandidateInvoice, b: CandidateInvoice) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id);

/** Oldest-first allocation of `amount` across invoices; never more than each balance. */
function fifo(amount: bigint, invoices: CandidateInvoice[]): Allocation[] {
  const out: Allocation[] = [];
  let left = amount;
  for (const inv of invoices) {
    if (left <= 0n) break;
    const take = left < inv.balanceCents ? left : inv.balanceCents;
    if (take > 0n) out.push({ invoiceId: inv.id, amountCents: take });
    left -= take;
  }
  return out;
}

const full = (invoices: CandidateInvoice[]): Allocation[] =>
  invoices.map((i) => ({ invoiceId: i.id, amountCents: i.balanceCents }));

/**
 * The combination of invoices whose balances sum exactly to `amount`.
 * Prefers the oldest debt (earliest latest-due date), then fewer invoices.
 */
export function exactSubset(amount: bigint, invoices: CandidateInvoice[]): CandidateInvoice[] | undefined {
  const list = [...invoices].sort(byDue).slice(0, MAX_SUBSET_SEARCH);
  let best: { set: CandidateInvoice[]; latestDue: string } | undefined;
  for (let mask = 1; mask < 1 << list.length; mask++) {
    const set = list.filter((_, i) => mask & (1 << i));
    if (sum(set.map((i) => i.balanceCents)) !== amount) continue;
    const latestDue = set[set.length - 1]!.dueOn;
    if (!best || latestDue < best.latestDue || (latestDue === best.latestDue && set.length < best.set.length)) {
      best = { set, latestDue };
    }
  }
  return best?.set;
}

/**
 * Decides how a payment applies to a client's open invoices.
 *
 * @param referenced invoice ids the payer quoted (may include paid or unknown ones)
 * @param fullyPaidReferenced quoted invoices that exist but have nothing left to pay
 */
export function planMatch(
  amount: bigint,
  candidates: CandidateInvoice[],
  referenced: string[],
  fullyPaidReferenced: string[],
  /** Intermediary charges the wire itself reports (SWIFT SHA). The payer sent amount + charges. */
  reportedChargesCents = 0n,
): MatchResult {
  const open = candidates.filter((c) => c.balanceCents > 0n).sort(byDue);
  const refd = open.filter((c) => referenced.includes(c.id));
  const plan = (p: Omit<MatchPlan, 'shortCents' | 'excessCents'> & Partial<MatchPlan>): MatchResult => ({
    kind: 'plan',
    plan: { shortCents: 0n, excessCents: 0n, ...p },
  });

  if (refd.length) {
    const owed = sum(refd.map((i) => i.balanceCents));
    if (amount === owed) {
      return plan({ method: 'referenced', allocations: full(refd), usedReferences: true, basis: 'Amount matches the quoted invoices' });
    }
    if (owed > amount && owed - amount <= SHORT_FEE_LIMIT_CENTS) {
      return plan({
        method: 'short_fee', allocations: fifo(amount, refd), shortCents: owed - amount, usedReferences: true,
        basis: 'Quoted invoices, short by an intermediary bank fee',
      });
    }
    if (amount > owed && refd.length === referenced.length) {
      return plan({
        method: 'overpaid', allocations: full(refd), excessCents: amount - owed, usedReferences: true,
        basis: 'Quoted invoices paid in full; the excess is held as credit',
      });
    }
  } else if (referenced.length && fullyPaidReferenced.length === referenced.length) {
    return { kind: 'duplicate', invoiceIds: fullyPaidReferenced };
  }

  // References missing or wrong: look for the exact set of open invoices the amount pays.
  const exact = exactSubset(amount, open);
  if (exact) {
    const wrongRefs = referenced.length > 0;
    return plan({
      method: exact.length === 1 ? 'exact' : 'split',
      allocations: full(exact),
      usedReferences: false,
      basis: wrongRefs
        ? 'Quoted invoices do not match the amount; it matches these open invoices exactly'
        : exact.length === 1
          ? 'Amount matches one open invoice exactly'
          : `Amount matches ${exact.length} open invoices exactly`,
    });
  }

  // The wire reports charges taken on the way: match what the payer sent, write off the charges.
  if (reportedChargesCents > 0n && reportedChargesCents <= SHORT_FEE_LIMIT_CENTS) {
    const sent = exactSubset(amount + reportedChargesCents, open);
    if (sent) {
      return plan({
        method: 'short_fee', allocations: fifo(amount, sent), shortCents: reportedChargesCents, usedReferences: false,
        basis: `Amount sent matches ${sent.length === 1 ? 'one open invoice' : `${sent.length} open invoices`} exactly; intermediary charges reported on the wire`,
      });
    }
  }

  if (refd.length) {
    return plan({ method: 'partial', allocations: fifo(amount, refd), usedReferences: true, basis: 'Partial payment of the quoted invoices' });
  }

  const totalOpen = sum(open.map((i) => i.balanceCents));
  if (open.length && amount > totalOpen) {
    return plan({
      method: 'overpaid', allocations: full(open), excessCents: amount - totalOpen, usedReferences: false,
      basis: 'Pays every open invoice; the excess is held as credit',
    });
  }
  if (open.length) {
    return plan({ method: 'partial', allocations: fifo(amount, open), usedReferences: false, basis: 'No exact match: applied to the oldest invoices first' });
  }
  return { kind: 'none', reason: 'Client has no open invoices' };
}

/** Lowercase, drop punctuation and common company suffixes, for name comparison. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(inc|llc|lp|ltd|plc|co|corp|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatUsd(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const dollars = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${dollars}.${(abs % 100n).toString().padStart(2, '0')}`;
}
