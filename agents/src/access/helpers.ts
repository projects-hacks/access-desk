import type { ClauseRow, ClientView, DeadlineRow, DecisionRow, InvoiceRow, WorkItemRow } from './model';
import { addDays } from './format';

export const LEVER_PRODUCT: Record<string, string> = { withdrawals: 'CUSTODY', trading: 'TRADING', api: 'API', financing: 'FINANCING' };
export const LEVER_WORDS: Record<string, string> = { withdrawals: 'withdrawals', trading: 'trading', api: 'API access', financing: 'financing' };
/** What the proposal says, as an instruction. */
export const PROPOSAL_WORDS: Record<string, string> = {
  REQUIRE_PREPAY: 'Require prepayment for new API usage',
  RATE_LIMIT: 'Rate-limit API access',
  READ_ONLY: 'Set API access to read-only',
  PAUSE_OTC: 'Pause OTC trading',
  NO_NEW_POSITIONS: 'Stop new positions (closing and hedging still allowed)',
  CLOSE_ONLY: 'Set trading to close-only',
  NO_NEW_BORROWING: 'Pause new borrowing',
  LOWER_LINE: 'Lower the credit line',
};
/** The product a lever's unpaid invoices are for, in words. */
export const PRODUCT_WORDS: Record<string, string> = { API: 'API', FINANCING: 'financing', TRADING: 'trading', CUSTODY: 'custody' };
/** The step, as what the desk is doing. */
export const STEP_ING: Record<string, string> = {
  REQUIRE_PREPAY: 'Requiring prepayment for API access', RATE_LIMIT: 'Rate-limiting API access', READ_ONLY: 'Setting API access to read-only', PAUSE_OTC: 'Pausing OTC trading',
  NO_NEW_POSITIONS: 'Stopping new positions', CLOSE_ONLY: 'Setting trading to close-only', NO_NEW_BORROWING: 'Pausing new borrowing', LOWER_LINE: 'Lowering the credit line',
  HOLD_AMOUNT_OWED: 'Holding the amount owed',
};
/** What the client is told was done. */
export const STEP_WORDS: Record<string, string> = {
  REQUIRE_PREPAY: 'required prepayment for new API usage',
  RATE_LIMIT: 'rate-limited API access',
  READ_ONLY: 'set API access to read-only',
  PAUSE_OTC: 'paused OTC trading',
  NO_NEW_POSITIONS: 'stopped new positions (you can still close or hedge existing ones)',
  CLOSE_ONLY: 'set trading to close-only',
  NO_NEW_BORROWING: 'paused new borrowing',
  LOWER_LINE: 'lowered your credit line',
  HOLD_AMOUNT_OWED: 'placed a hold on withdrawals equal to the amount past due',
};
/** The same steps, short, for "refused: ..." on the panel. */
export const STEP_SHORT: Record<string, string> = {
  REQUIRE_PREPAY: 'require prepayment', RATE_LIMIT: 'rate-limit the API', READ_ONLY: 'set the API to read-only', PAUSE_OTC: 'pause OTC trading',
  NO_NEW_POSITIONS: 'stop new positions', CLOSE_ONLY: 'set trading to close-only', NO_NEW_BORROWING: 'pause new borrowing',
  LOWER_LINE: 'lower the credit line', HOLD_AMOUNT_OWED: 'hold the amount owed',
};

export const OPEN = new Set(['PROPOSED', 'NEEDS_INFO']);
/** Kinds this agent proposes that a gateway executes. */
export const EXECUTED_KINDS = new Set(['RESTRICTION', 'RESTORE', 'CUSTODY_DEBIT', 'REMINDER']);
export const OUR_KINDS = new Set([...EXECUTED_KINDS, 'NOVEL_CASE']);

/** The work item's proposal as an object; {} when it isn't JSON. */
export function proposalOf(w: Pick<WorkItemRow, 'proposalJson'>): Record<string, any> {
  try {
    const p = JSON.parse(w.proposalJson);
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

export const graceDays = (v: ClientView) => v.contract?.graceDays ?? 0;
export const clause = (v: ClientView, kind: string): ClauseRow | undefined => v.clauses.find((c) => c.kind === kind);
export const cite = (v: ClientView, kind: string) => {
  const c = clause(v, kind);
  return c ? ` (§${c.clause})` : '';
};
export const allowed = (v: ClientView, kind: string) => !!clause(v, kind)?.allowed;
export const owed = (invoices: InvoiceRow[]) => invoices.reduce((s, i) => s + i.amountCents - i.paidCents, 0);
export const ids = (invoices: InvoiceRow[]) => invoices.map((i) => i.id).join(', ');
export const usdCash = (v: ClientView) => v.custody.find((h) => h.asset === 'USD')?.valueCents ?? 0;

const byDue = (a: InvoiceRow, b: InvoiceRow) => (a.dueOn === b.dueOn ? (a.id < b.id ? -1 : 1) : a.dueOn < b.dueOn ? -1 : 1);

/** Past due, undisputed and unpaid, oldest first. */
export const overdueInvoices = (v: ClientView, today: string) =>
  v.invoices.filter((i) => i.dueOn < today && i.status !== 'disputed' && i.paidCents < i.amountCents).sort(byDue);

/** Unpaid past the grace period and not under a dispute filed by today. */
export function defaultedInvoices(v: ClientView, today: string): InvoiceRow[] {
  const grace = graceDays(v);
  const disputed = new Set(v.disputes.filter((d) => d.status !== 'resolved' && d.openedOn <= today).map((d) => d.invoiceId));
  return v.invoices.filter((i) => i.paidCents < i.amountCents && addDays(i.dueOn, grace) < today && !disputed.has(i.id));
}

export const openInvoices = (v: ClientView) => v.invoices.filter((i) => i.paidCents < i.amountCents && i.status !== 'disputed');

export function latestDeadline(v: ClientView, kind: string): DeadlineRow | undefined {
  return v.deadlines.filter((d) => d.kind === kind).reduce<DeadlineRow | undefined>((a, d) => (!a || d.id > a.id ? d : a), undefined);
}

export const hedged = (v: ClientView) => v.positions.some((p) => p.status === 'open' && p.hedgeGroup);

export const rejectedSince = (v: ClientView, since: string, kind: string): DecisionRow | undefined =>
  v.rejections.find((r) => r.simDate >= since && r.workItemKind === kind);

export const noteTag = (id: number) => `(re RM-${id})`;

/** Has the agent answered this RM note, by a reply to the RM or a case for a controller? */
export const answered = (v: ClientView, noteId: number) =>
  v.workItems.some((w) => w.subjectId === `rm_note:${noteId}` || (w.kind === 'REMINDER' && w.proposalJson.includes(noteTag(noteId))));
