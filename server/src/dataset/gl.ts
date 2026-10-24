import type { Product } from '../domain';
import { addDays } from './dates';
import type { Dataset, IsoDate } from './types';

/** Chart of accounts for the platform's general ledger. */
export const ACCOUNTS = {
  CASH_COLLECTIONS: '1010',
  CASH_DISBURSEMENTS: '1011',
  CASH_WALLET: '1015',
  RECEIVABLES: '1200',
  LOANS: '1300',
  CLIENT_FUNDS: '2100',
  UNAPPLIED_CASH: '2300',
  BANK_FEES: '6850',
  EQUITY: '3000',
} as const;

/** Bank balances before the first movement in the data (Nessie's balance field can't carry them). Booked in the GL too, so bank = ledger. */
export const BANK_OPENING_CENTS: Record<string, number> = { collections: 200_000_000, disbursements: 500_000_000 };

export const REVENUE: Record<Product, string> = {
  CUSTODY: '4100',
  TRADING: '4200',
  FINANCING: '4300',
  API: '4400',
};

export const ACCOUNT_NAMES: Record<string, string> = {
  '1010': 'Cash · Collections',
  '1011': 'Cash · Disbursements',
  '1015': 'Cash · USDC wallet',
  '1200': 'Accounts receivable',
  '1300': 'Loans receivable',
  '2100': 'Client funds',
  '2300': 'Unapplied cash and credits',
  '4100': 'Revenue · Custody',
  '4200': 'Revenue · Trading',
  '4300': 'Revenue · Financing',
  '4400': 'Revenue · API',
  '6850': 'Bank fees',
  '3000': 'Equity · owner funding',
};

export const cashAccount = (platformAccount: string): string =>
  platformAccount === 'disbursements' ? ACCOUNTS.CASH_DISBURSEMENTS
    : platformAccount === 'wallet' ? ACCOUNTS.CASH_WALLET
      : ACCOUNTS.CASH_COLLECTIONS;

export interface JournalLine {
  account: string;
  debitCents: number;
  creditCents: number;
}

export interface Journal {
  journalId: string;
  postedOn: IsoDate;
  ref: string;
  memo: string;
  /** Who booked it: billing, treasury (before our system), or access-desk (via the gateway). */
  source: 'billing' | 'treasury' | 'access-desk';
  lines: JournalLine[];
}

const dr = (account: string, cents: number): JournalLine => ({ account, debitCents: cents, creditCents: 0 });
const cr = (account: string, cents: number): JournalLine => ({ account, debitCents: 0, creditCents: cents });

export function isBalanced(j: Journal): boolean {
  const d = j.lines.reduce((s, l) => s + l.debitCents, 0);
  const c = j.lines.reduce((s, l) => s + l.creditCents, 0);
  return d === c && d > 0 && j.lines.every((l) => l.debitCents >= 0 && l.creditCents >= 0);
}

/**
 * The ledger as it stood before our system ran (the day before the sim date).
 * Treasury booked receipts it saw; billing booked invoices and the cash it applied.
 * Anything else (overnight cash, the ACH return) is left for our system to book.
 */
export function baselineJournals(ds: Dataset): Journal[] {
  const cutoff = addDays(ds.simDate, -1); // overnight cash (from this date) isn't booked yet
  const journals: Journal[] = [];

  // Opening bank balances, funded by the owners the day before the first movement.
  const first = [...ds.history.cash.map((p) => p.valueDate), ...ds.movements.map((m) => m.valueDate)].sort()[0] ?? ds.simDate;
  const opening = BANK_OPENING_CENTS.collections! + BANK_OPENING_CENTS.disbursements!;
  journals.push({
    journalId: 'JE-OPEN', postedOn: addDays(first, -1), ref: 'OPENING', memo: 'Opening bank balances', source: 'treasury',
    lines: [dr(ACCOUNTS.CASH_COLLECTIONS, BANK_OPENING_CENTS.collections!), dr(ACCOUNTS.CASH_DISBURSEMENTS, BANK_OPENING_CENTS.disbursements!), cr(ACCOUNTS.EQUITY, opening)],
  });

  for (const i of ds.invoices.filter((x) => x.issuedOn <= ds.simDate)) {
    journals.push({
      journalId: `JE-INV-${i.id}`, postedOn: i.issuedOn, ref: i.id, memo: `${i.label} · ${i.period}`, source: 'billing',
      lines: [dr(ACCOUNTS.RECEIVABLES, i.amountCents), cr(REVENUE[i.product], i.amountCents)],
    });
  }

  // History cash: billing received and applied in one step.
  for (const p of ds.history.cash) {
    const cash = p.rail === 'USDC' ? ACCOUNTS.CASH_WALLET : ACCOUNTS.CASH_COLLECTIONS;
    journals.push({
      journalId: `JE-H-${p.id}`, postedOn: p.valueDate, ref: p.id, memo: `Receipt applied · ${p.refs.join(' ')}`, source: 'billing',
      lines: [dr(cash, p.amountCents), cr(ACCOUNTS.RECEIVABLES, p.amountCents)],
    });
  }

  // Bank window, before the cutoff: treasury booked what posted; billing applied what it applied.
  const applied = new Set(ds.invoices.filter((i) => i.paidCents > 0 && i.issuedOn >= '2026-01-01').map((i) => i.id));
  for (const m of ds.movements.filter((x) => x.valueDate < cutoff && x.status === 'completed')) {
    const cash = m.platformAccount === 'disbursements' ? ACCOUNTS.CASH_DISBURSEMENTS : ACCOUNTS.CASH_COLLECTIONS;
    const base = { postedOn: m.valueDate, ref: m.id, source: 'treasury' as const };
    switch (m.kind) {
      case 'client_payment':
        journals.push({ ...base, journalId: `JE-T-${m.id}`, memo: 'Receipt to unapplied cash', lines: [dr(cash, m.amountCents), cr(ACCOUNTS.UNAPPLIED_CASH, m.amountCents)] });
        break;
      case 'loan_repayment':
        journals.push({ ...base, journalId: `JE-T-${m.id}`, memo: `Loan repayment ${m.refs.join(' ')}`, lines: [dr(cash, m.amountCents), cr(ACCOUNTS.LOANS, m.amountCents)] });
        break;
      case 'loan_disbursement':
        journals.push({ ...base, journalId: `JE-T-${m.id}`, memo: `Loan disbursed ${m.refs.join(' ')}`, lines: [dr(ACCOUNTS.LOANS, m.amountCents), cr(cash, m.amountCents)] });
        break;
      case 'bank_fee':
        journals.push({ ...base, journalId: `JE-T-${m.id}`, memo: 'Bank fees', lines: [dr(ACCOUNTS.BANK_FEES, m.amountCents), cr(cash, m.amountCents)] });
        break;
      case 'ach_return':
        // Nobody booked the return: this is the trap our system must catch.
        break;
    }
  }

  // Billing's own applications of window cash ("prior"): unapplied → receivables.
  // One application per invoice billing marked paid, in the amount it applied.
  const firstPayment = new Map<string, string>();
  for (const m of ds.movements.filter((x) => x.kind === 'client_payment' && x.valueDate < cutoff).sort((a, b) => a.valueDate.localeCompare(b.valueDate))) {
    for (const ref of m.refs) if (!firstPayment.has(ref)) firstPayment.set(ref, m.id);
  }
  for (const i of ds.invoices.filter((x) => applied.has(x.id))) {
    const by = firstPayment.get(i.id);
    if (!by) continue;
    const m = ds.movements.find((x) => x.id === by)!;
    // Billing never applied cash it didn't see as matched (Saltmarsh's wire stays in unapplied).
    if (m.caseId === 'paid-not-applied') continue;
    journals.push({
      journalId: `JE-A-${i.id}`, postedOn: m.valueDate, ref: m.id, memo: `Applied to ${i.id}`, source: 'billing',
      lines: [dr(ACCOUNTS.UNAPPLIED_CASH, i.paidCents), cr(ACCOUNTS.RECEIVABLES, i.paidCents)],
    });
  }

  return journals.sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.journalId.localeCompare(b.journalId));
}

export function trialBalance(journals: Journal[]): Map<string, number> {
  const tb = new Map<string, number>();
  for (const j of journals) for (const l of j.lines) tb.set(l.account, (tb.get(l.account) ?? 0) + l.debitCents - l.creditCents);
  return tb;
}
