/** Typed inputs (one ClientBook per client) and outputs of the credit engine. */

export interface Client {
  id: string;
  name: string;
  segment: string;
  tier: number;
  strategic: boolean;
  renewalOn: string | null;
}

export interface Contract {
  termsDays: number;
  graceDays: number;
  cureDays: number;
  crossDefault: boolean;
}

export interface Clause {
  clause: string;
  kind: string;
  allowed: boolean;
}

export interface Payment {
  valueOn: string;
  amountCents: number;
}

export interface Invoice {
  id: string;
  product: string;
  period: string;
  issuedOn: string;
  dueOn: string;
  amountCents: number;
  paidCents: number;
  paidOn: string | null;
  status: string;
  payments: Payment[];
}

export interface Dispute {
  id: string;
  invoiceId: string;
  openedOn: string;
  resolvedOn: string | null;
  resolution: string;
  status: string;
}

export interface Holding {
  asset: string;
  valueCents: number;
}

/** Everything the engine may know about one client on `today` (nothing dated later). */
export interface ClientBook {
  client: Client;
  contract: Contract;
  clauses: Clause[];
  invoices: Invoice[];
  disputes: Dispute[];
  custody: Holding[];
  owedToClientCents: number;
  today: string;
}

export const clauseOf = (book: ClientBook, kind: string) => book.clauses.find((c) => c.kind === kind);

export function openDisputeInvoiceIds(book: ClientBook): Set<string> {
  const ids = new Set(book.disputes.filter((d) => d.status === 'under_review').map((d) => d.invoiceId));
  for (const i of book.invoices) if (i.status === 'disputed') ids.add(i.id);
  return ids;
}

export interface Scores {
  clientId: string;
  reliability: number;
  value: number;
  coverageRatio: number;
  coverageDetail: string;
  exposureCents: number;
  expectedSettleOn: string | null;
  breakdown: Record<string, number>;
}

export interface Evidence {
  invoiceId: string;
  dueOn: string;
  paidOn: string | null;
  dpd: number;
  note: string;
}

export interface Flag {
  pattern: string;
  fired: boolean;
  measured: string;
  evidence: Evidence[];
  months: number;
  score: number;
  proposedFix: string;
}

export type TierAction = 'stay' | 'tier_change' | 'review';

export interface TierDecision {
  clientId: string;
  current: number;
  formula: number;
  action: TierAction;
  toTier: number;
  confidence: number;
  policyRef: string;
  reasons: string[];
}

const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;

/** The numbers that travel with a CREDIT_REVIEW proposal. */
export function proposalNumbers(d: TierDecision, scores: Scores, flags: Flag[]) {
  return {
    action: d.action,
    from_tier: d.current,
    to_tier: d.toTier,
    reliability: round(scores.reliability, 1),
    value: round(scores.value, 1),
    coverage_ratio: round(scores.coverageRatio, 2),
    breakdown: Object.fromEntries(Object.entries(scores.breakdown).map(([k, v]) => [k, round(v, 2)])),
    flags: flags.filter((f) => f.fired).map((f) => f.pattern),
    expected_settle_on: scores.expectedSettleOn,
  };
}
