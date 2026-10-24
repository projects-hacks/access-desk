import type { Product } from '../domain';

/** ISO date, YYYY-MM-DD. */
export type IsoDate = string;

export type Segment = 'Hedge fund' | 'Market maker' | 'Corporate treasury' | 'Fintech';

/** How a client behaves on its January invoices (issued Feb 1). */
export type JanBehavior =
  | { kind: 'paid'; daysFromDue: number }
  | { kind: 'open' }
  /** Pays the platform through an affiliate's bank account. */
  | { kind: 'paid_by_affiliate'; affiliate: string; daysFromDue: number }
  /** International wire (SWIFT, charges SHA): an intermediary bank deducts its fee on the way. */
  | { kind: 'short_paid'; shortCents: number; valueDate: IsoDate }
  /** Lump sum with only the client id as reference, covering several months. */
  | { kind: 'lump_sum_no_invoice_refs'; valueDate: IsoDate }
  /** No reference at all and an abbreviated originator name. */
  | { kind: 'no_reference'; memoName: string; valueDate: IsoDate }
  /** Paid weeks ago, but billing never applied the cash. */
  | { kind: 'paid_not_applied'; valueDate: IsoDate }
  /** Paid part of one invoice. */
  | { kind: 'partial'; invoiceProduct: Product; fraction: number; valueDate: IsoDate }
  /** Wire sent, bank hasn't posted it yet. */
  | { kind: 'in_transit'; valueDate: IsoDate }
  /** On ACH auto-debit: we collect, and the debit comes back R01 (insufficient funds). */
  | { kind: 'ach_returned'; paidOn: IsoDate; returnedOn: IsoDate }
  /** Settled outside the bank: on-chain USDC. */
  | { kind: 'paid_onchain'; valueDate: IsoDate; wallet: string }
  /** Pays more than owed; the excess becomes credit on account. */
  | { kind: 'overpaid'; extraCents: number; daysFromDue: number }
  /** Same wire sent twice. */
  | { kind: 'duplicate_wire'; daysFromDue: number; duplicateAfterDays: number }
  /** Quotes the wrong invoice numbers (next month's) but pays this month's amount. */
  | { kind: 'wrong_reference'; daysFromDue: number }
  /** Pays from a bank account the platform has never seen. */
  | { kind: 'new_bank_account'; daysFromDue: number }
  /** The live demo wire: an affiliate wire that arrives during the demo. */
  | { kind: 'demo_affiliate_wire'; affiliate: string; wireId: string; valueDate: IsoDate };

export interface Client {
  id: string;
  name: string;
  legalName: string;
  segment: Segment;
  tier: 1 | 2 | 3 | 4 | 5;
  products: Product[];
  strategic?: boolean;
  termsDays: number;
  relationshipManager: string;
  /** Typical monthly billing per product, in dollars. */
  monthly: Partial<Record<Product, number>>;
  /** Exact January amounts, in dollars, where the story needs specific numbers. */
  janOverride?: Partial<Record<Product, number>>;
  jan: JanBehavior;
  /** Months before January that are still unpaid (chronic late payers). */
  olderOpenPeriods?: string[];
  /** Extra one-off invoices, e.g. a disputed overage. */
  extraJanInvoices?: Array<{ product: Product; label: string; amount: number; disputed?: boolean }>;
  city: string;
  state: string;
  /** Where the client banks. International clients pay by SWIFT. */
  bank: { name: string; id: string; country: string };
}

export interface Affiliate {
  key: string;
  legalName: string;
  parentId: string;
  relation: string;
  bank: { name: string; id: string; country: string };
}

export type InvoiceStatus = 'open' | 'paid' | 'disputed';

export interface Invoice {
  id: string;
  clientId: string;
  product: Product;
  label: string;
  period: string;
  issuedOn: IsoDate;
  dueOn: IsoDate;
  amountCents: number;
  /** What the billing system has applied so far (before our matching runs). */
  paidCents: number;
  /** When billing recorded the final payment (paid invoices only). */
  paidOn?: IsoDate;
  status: InvoiceStatus;
}

export type Party =
  /** `secondary` = a second bank account the CRM doesn't know about. */
  | { type: 'client'; id: string; account?: 'primary' | 'secondary' }
  | { type: 'affiliate'; key: string };

export type PlatformAccount = 'collections' | 'disbursements';

export type MovementKind =
  | 'client_payment'
  | 'ach_return'
  | 'loan_disbursement'
  | 'loan_repayment'
  | 'bank_fee';

/** One movement of cash at the bank, seen from the platform's side. */
export interface BankMovement {
  id: string;
  kind: MovementKind;
  rail: 'WIRE' | 'ACH' | 'BOOK';
  direction: 'in' | 'out';
  platformAccount: PlatformAccount;
  /** Counterparty; absent for bank fees. */
  party?: Party;
  amountCents: number;
  valueDate: IsoDate;
  status: 'completed' | 'pending';
  /** Status of the counterparty's side, when it differs (e.g. sent but not yet posted to us). */
  counterpartyStatus?: 'completed' | 'pending';
  refs: string[];
  /** Overrides the originator name printed in the memo. */
  memoName?: string;
  /** For returns: the movement being reversed. */
  reverses?: string;
  /** International wires: what the payer sent before intermediary charges, and the charges. */
  instructedCents?: number;
  chargesCents?: number;
  chargeBearer?: 'SHA' | 'OUR' | 'BEN';
  /** Free-text remittance the payer wrote instead of invoice numbers. */
  remittanceText?: string;
  caseId?: string;
}

export interface OnchainPayment {
  txHash: string;
  wallet: string;
  clientId?: string;
  amountCents: number;
  asset: 'USDC';
  valueDate: IsoDate;
  refs: string[];
  caseId?: string;
}

export interface Loan {
  id: string;
  clientId: string;
  lineCents: number;
  outstandingCents: number;
  openedOn: IsoDate;
}

/** A planted situation with the outcome the system is expected to reach. */
export interface PlantedCase {
  id: string;
  title: string;
  clientId: string;
  expected: string;
  demoStep?: number;
}

/** Cash from before the bank window: 12 months of payments billing already applied. */
export interface HistoryPayment {
  id: string;
  clientId: string;
  rail: 'WIRE' | 'ACH' | 'USDC';
  amountCents: number;
  valueDate: IsoDate;
  refs: string[];
}

/** A past decision and how it turned out. Feeds policy drafting and replay. */
export interface Precedent {
  id: string;
  clientId: string;
  decidedOn: IsoDate;
  situation: string;
  proposed: string;
  decision: string;
  overrideReason: string;
  outcome: string;
  policyRef: string;
}

export interface MetricSnapshot {
  id: string;
  weekEnding: IsoDate;
  metric: string;
  value: number;
}

export interface Dataset {
  simDate: IsoDate;
  /** Bank data before this date stays in the simulator's history only. */
  bankWindowStart: IsoDate;
  platform: { name: string; legalName: string };
  clients: Client[];
  affiliates: Affiliate[];
  invoices: Invoice[];
  movements: BankMovement[];
  onchain: OnchainPayment[];
  loans: Loan[];
  cases: PlantedCase[];
  history: {
    start: IsoDate;
    cash: HistoryPayment[];
    precedents: Precedent[];
    metrics: MetricSnapshot[];
  };
}
