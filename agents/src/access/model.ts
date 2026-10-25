import type { RmReading } from './pushback';

/**
 * What the access controller reads about one client: plain rows with money in cents as numbers
 * (load.ts maps them from the live cache), so the rules in plan.ts are pure and easy to test.
 */

export interface ClientRow { id: string; name: string; legalName: string; tier: number; strategic: boolean; relationshipManager: string; renewalOn?: string }
export interface ContractRow { graceDays: number; cureDays: number; crossDefault: boolean }
export interface InvoiceRow { id: string; product: string; issuedOn: string; dueOn: string; amountCents: number; paidCents: number; paidOn?: string; status: string }
export interface DisputeRow { invoiceId: string; openedOn: string; status: string }
export interface ClauseRow { clause: string; kind: string; allowed: boolean; text: string }
export interface LeverRow { lever: string; state: string; detail: string; workItemId?: number }
export interface CustodyRow { asset: string; valueCents: number }
export interface PositionRow { status: string; hedgeGroup?: string; notionalCents: number }
export interface WorkItemRow { id: number; kind: string; subjectId: string; state: string; title: string; requiredRole: string; policyRef: string; amountCents: number; proposalJson: string }
export interface DeadlineRow { id: number; kind: string; status: string; startedOn: string; dueOn: string; note: string }
export interface PayerRow { value: string }
export interface FlagRow { status: string; pattern: string }
export interface RmNoteRow { id: number; author: string; text: string }
export interface PrecedentRow { id: string; clientId: string; workItemId?: number; decidedOn: string; situation: string; proposed: string; decision: string; overrideReason: string; outcome: string; policyRef: string; source: string }
export interface AccessRequestRow { action: string; decision: string; allowedCents: number }
export interface CashRow {
  id: string; amountCents: number; rail: string; bankRef: string; origName: string; origAccount: string; valueOn: string; status: string; matchStatus: string;
  memo: string; remittance: string; refs: string[]; returnCode?: string;
}
/** A person's (or a policy's) decision on one of the client's work items, from the audit log. */
export interface DecisionRow { workItemId: number; workItemKind: string; toState: string; simDate: string; detail: string; action: string }
export interface CapabilityRow { lever: string; step: string; gentleness: number; twoApprovers: boolean }
export interface PolicyRow { policyId: string; title: string; ruleJson: string }

export interface ClientView {
  client: ClientRow;
  contract?: ContractRow;
  invoices: InvoiceRow[];
  disputes: DisputeRow[];
  clauses: ClauseRow[];
  levers: LeverRow[];
  custody: CustodyRow[];
  positions: PositionRow[];
  workItems: WorkItemRow[];
  deadlines: DeadlineRow[];
  payers: PayerRow[];
  flags: FlagRow[];
  rmNotes: RmNoteRow[];
  precedents: PrecedentRow[];
  accessRequests: AccessRequestRow[];
  /** Incoming cash from this client (by its invoices, name or known payer accounts). */
  cash: CashRow[];
  inTransit: CashRow[];
  rejections: DecisionRow[];
  approvals: DecisionRow[];
  withdrawals: DecisionRow[];
}

/** What the rules need beyond the client itself. */
export interface World {
  today: string;
  wireInstructions: string;
  capability: CapabilityRow[];
  /** Active policies only. */
  policies: PolicyRow[];
  /** Work item id -> why the gateway could not execute it. */
  failedCommands: Map<number, string>;
  /** NOVEL_CASE work items whose investigation steps are already recorded. */
  investigated: Set<number>;
  /** The reason of the last AGENT_WAITED row for this client, so the same wait is not recorded twice. */
  lastWait?: string;
  readings: Map<number, RmReading>;
  /** Posted incoming cash nobody claims yet; read only when an RM says the client paid. */
  unplaced: () => CashRow[];
}

/** A deliberate decision not to act on a client who owes money, and why. */
export interface Wait { code: string; reason: string }

export interface NoticeMove { kind: 'notice'; channel: 'email' | 'portal' | 'rm'; body: string; reasoning: string; policyRef: string; confidence: number; summary: string }

/** What the controller wants a reducer to do, with the reasoning it will cite. */
export type Move =
  | NoticeMove
  | {
    kind: 'restriction'; lever: string; step: string; reasoning: string; policyRef: string; confidence: number; boundaries: unknown;
    summary: string; what: string; headline: string; why: string;
  }
  | { kind: 'custody_debit'; invoiceIds: string[]; reasoning: string; policyRef: string; confidence: number; summary: string; what: string; headline: string }
  | { kind: 'restore'; lever: string; reasoning: string; policyRef: string; confidence: number; summary: string; what: string; headline: string }
  | {
    /** `reply` goes out if the match is refused, `after` once it went through. */
    kind: 'payment_match'; movementId: string; rmNoteId: number; reasoning: string; evidence: WireEvidence; summary: string;
    reply: NoticeMove; after: NoticeMove;
  }
  | { kind: 'case'; proposal: CaseProposal; summary: string }
  | { kind: 'precedent'; row: PrecedentRow; summary: string }
  | { kind: 'investigation'; workItemId: number; steps: { tool: string; summary: string; status: string }[]; summary: string };

/** A NOVEL_CASE for a controller (propose_work_item). */
export interface CaseProposal {
  kind: 'NOVEL_CASE'; subjectId: string; title: string; amountCents: number; proposal: Record<string, unknown>; reasoning: string;
  policyRef: string; clausesCited: string[]; confidence: number;
}

export interface WireEvidence {
  kind: 'payment_attribution'; movementId: string; bankRef: string; amountCents: number; from: string; valueOn: string; invoices: string[];
  signals: { kind: string; detail: string }[]; confidence: number;
}

/** One pass over one client: bookkeeping first, then at most one decision (or a wait). */
export interface Plan { bookkeeping: Move[]; decision?: Move; wait?: Wait; /** The wait differs from the last one recorded. */ recordWait?: boolean }
