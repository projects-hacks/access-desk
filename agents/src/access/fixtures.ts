import type { CashRow, ClientView, DecisionRow, InvoiceRow, LeverRow, Move, Plan, WorkItemRow, World } from './model';
import { ladders, plan } from './plan';
import type { Ask } from '../types';
import type { RmReading } from './pushback';

/** Test fixtures: a client whose cure period ran out, and helpers to plan against it. */

export const TODAY = '2026-03-20';
export const LADDER: Record<string, string[]> = {
  api: ['REQUIRE_PREPAY', 'RATE_LIMIT', 'READ_ONLY'],
  trading: ['PAUSE_OTC', 'NO_NEW_POSITIONS', 'CLOSE_ONLY'],
  financing: ['NO_NEW_BORROWING', 'LOWER_LINE'],
  withdrawals: ['FEE_DEBIT', 'HOLD_AMOUNT_OWED', 'FULL_FREEZE'],
};
export const capability = () => Object.entries(LADDER).flatMap(([lever, steps]) => steps.map((step, i) => ({ lever, step, gentleness: i + 1, twoApprovers: false })));

export interface ViewOpts extends Partial<ClientView> {
  products?: string[];
  owed?: [string, string, number][];
  debit?: boolean;
  setOff?: boolean;
  cure?: string | null;
  cureDue?: string;
  tier?: number;
  usd?: number;
}

export function view({ products = ['TRADING', 'CUSTODY'], owed = [['INV-1', 'TRADING', 5_000_000]], debit = false, setOff = true, cure = 'expired', cureDue = '2026-03-01', tier = 3, usd = 0, ...extra }: ViewOpts = {}): ClientView {
  const levers: LeverRow[] = [['withdrawals', 'CUSTODY'], ['trading', 'TRADING'], ['api', 'API'], ['financing', 'FINANCING']]
    .map(([lever, product]) => ({ lever: lever!, state: products.includes(product!) ? 'active' : 'not_used', detail: 'Normal' }));
  return {
    client: { id: 'ORG-1', name: 'Acme', legalName: 'Acme LP', tier, strategic: false, relationshipManager: 'Priya Nair' },
    contract: { graceDays: 10, cureDays: 15, crossDefault: false },
    invoices: owed.map(([id, product, amountCents]) => ({ id, product, issuedOn: '2026-01-15', dueOn: '2026-02-01', amountCents, paidCents: 0, status: 'open' })),
    disputes: [],
    clauses: [
      { kind: 'set_off', clause: '7.2', allowed: setOff, text: '' },
      { kind: 'debit', clause: '6.3', allowed: debit, text: '' },
      { kind: 'cure', clause: '9.1', allowed: true, text: '' },
    ],
    levers,
    custody: [{ asset: 'USD', valueCents: usd }],
    positions: [], workItems: [], payers: [], flags: [], rmNotes: [], precedents: [], accessRequests: [], cash: [], inTransit: [], rejections: [], approvals: [], withdrawals: [],
    deadlines: cure ? [{ id: 1, kind: 'cure_period', startedOn: '2026-02-14', dueOn: cureDue, status: cure, note: '' }] : [],
    ...extra,
  };
}

export const lever = (name: string, state: string, detail: string): LeverRow => ({ lever: name, state, detail });

export const event = (toState: string, simDate: string, workItemId: number, workItemKind = 'RESTRICTION', detail = ''): DecisionRow => ({ toState, simDate, workItemId, workItemKind, detail, action: 'TRANSITION' });

export const item = (id: number, kind: string, state: string, proposal: object = {}, extra: Partial<WorkItemRow> = {}): WorkItemRow => ({
  id, kind, state, subjectId: 'ORG-1', proposalJson: JSON.stringify(proposal), title: `${kind} ${id}`, policyRef: 'pol-006', requiredRole: 'CONTROLLER', amountCents: 0, ...extra,
});

export const note = (id = 4, author = 'Priya Nair', text = '...') => ({ id, author, text });

export function wire(o: Partial<CashRow> & { match?: string; ref?: string; orig?: string; amount?: number } = {}): CashRow {
  const { match = 'matched', ref = 'WI-1', orig = 'ACME LP', amount = 5_000_000, ...rest } = o;
  return { id: `nessie:${ref}`, amountCents: amount, rail: 'WIRE', bankRef: ref, origName: orig, origAccount: '', valueOn: '2026-03-02', status: 'posted', matchStatus: match, memo: '', remittance: '', refs: [], ...rest };
}

export const reading = (o: Partial<RmReading> = {}): RmReading => ({
  intent: 'other', summary: '', claimedAmountUsd: null, paymentReference: null, graceUntil: null, reason: null, eventType: null, counterparty: null, effectiveDate: null, readBy: 'keywords', ...o,
});
export const PAID = reading({ intent: 'already_paid', summary: 'wire sent', claimedAmountUsd: 50_000, paymentReference: 'IMAD123456' });
export const HOLD_OFF = reading({ intent: 'exception_request', summary: 'hold off', graceUntil: '2026-03-31', reason: 'acquisition' });

/** A World, with the RM readings given as { noteId: reading }. */
export type WorldOpts = Omit<Partial<World>, 'readings'> & { readings?: Record<number, RmReading> };

export function world({ readings = {}, ...rest }: WorldOpts = {}): World {
  return {
    today: TODAY, wireInstructions: 'ACCT 1', capability: capability(), policies: [], failedCommands: new Map(), investigated: new Set(), unplaced: () => [],
    ...rest, readings: new Map(Object.entries(readings).map(([k, v]) => [Number(k), v])),
  };
}

export const planFor = (v: ClientView, w: WorldOpts = {}): Plan => {
  const full = world(w);
  return plan(v, full, ladders(full.capability), 7);
};

/** The one thing the agent would do (bookkeeping aside), if anything. */
export const only = (v: ClientView, w: WorldOpts = {}): Move | undefined => planFor(v, w).decision;
export const waited = (v: ClientView, w: WorldOpts = {}) => planFor(v, w).wait;

export const invoicePaid = (i: InvoiceRow, paidOn: string): InvoiceRow => ({ ...i, paidCents: i.amountCents, paidOn, status: 'paid' });

/** An Ask that answers `answer` through the caller's validation (with who answered), like the real one. */
export const answering = (answer: unknown, provider = 'anthropic'): Ask => async ({ validate }) =>
  (validate ? (validate as (v: unknown, by: { provider: string }) => unknown)(answer, { provider }) : answer) as never;
