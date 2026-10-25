import type { Client, Dataset, IsoDate } from '../dataset';
import { unit } from '../dataset/build';
import { addDays, daysBetween } from '../dataset/dates';
import { HISTORY_PERIODS } from '../dataset/history';
import { TYPO_CLIENTS } from '../integrations/nessie/seed-plan';

/**
 * How each client pays, read from its own history in the dataset (twelve months of payments, its
 * disputes) and its January story. Nothing here is random: a client has one personality, and when
 * it pays a given invoice is a stable function of the client and the invoice.
 */
export const PERSONALITIES = ['on_time', 'slow', 'partial', 'gamer', 'disputer', 'quarter_end', 'delinquent'] as const;
export type Personality = (typeof PERSONALITIES)[number];

export const PERSONALITY_TEXT: Record<Personality, string> = {
  on_time: 'pays on or just before the due date',
  slow: 'pays a week or two after the due date, as its history shows',
  partial: 'pays half now and half weeks later',
  gamer: 'waits for the default notice and pays the day before the cure period ends',
  disputer: 'pays about a month late, after the dispute window',
  quarter_end: 'pays everything at quarter end',
  delinquent: 'has old invoices unpaid; pays rarely and only part',
};

export interface Profile {
  clientId: string;
  name: string;
  personality: Personality;
  /** Median days after the due date it paid in the last twelve months. */
  medianLate: number;
  rail: 'WIRE' | 'ACH';
  /** What it writes in the remittance: invoice numbers, only its client id on catch-up wires, or nothing (account and amount only). */
  reference: 'invoices' | 'client' | 'none';
  /** Originator name as the bank prints it, when abbreviated. */
  memoName?: string;
  /** The entity that sometimes pays for it (general partner, feeder fund). */
  affiliateKey?: string;
  international: boolean;
  overpays: boolean;
  duplicates: boolean;
  /** Sometimes keys a letter for a digit in the invoice number. */
  typos: boolean;
}

export interface CureView {
  state: 'running' | 'expired';
  dueOn: IsoDate;
}

/** Paying up to this many days late, on average, still counts as paying on time (it is inside the grace period of every tier). */
const ON_TIME_MEDIAN = 3;

const QUARTER_END_DAYS = ['03-31', '06-30', '09-30', '12-31'];

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

export function quarterEndOnOrAfter(date: IsoDate): IsoDate {
  const y = Number(date.slice(0, 4));
  return [...QUARTER_END_DAYS.map((d) => `${y}-${d}`), `${y + 1}-03-31`].find((q) => q >= date)!;
}

export function deriveProfile(c: Client, ds: Dataset): Profile {
  const history = ds.invoices.filter((i) => i.clientId === c.id && i.paidOn && HISTORY_PERIODS.includes(i.period));
  const late = history.map((i) => daysBetween(i.dueOn, i.paidOn!));
  const share = (test: (days: number) => boolean) => (late.length ? late.filter(test).length / late.length : 0);

  const cash = ds.history.cash.filter((p) => p.clientId === c.id);
  const quarterEnd = cash.length > 0 && cash.filter((p) => QUARTER_END_DAYS.includes(p.valueDate.slice(5))).length / cash.length >= 0.6;
  const split = history.length > 0 && history.filter((i) => cash.filter((p) => p.refs.includes(i.id)).length >= 2).length / history.length >= 0.5;
  const disputes = ds.history.disputes.filter((d) => d.clientId === c.id).length;
  const medianLate = median(late);

  let personality: Personality;
  if (c.olderOpenPeriods?.length && c.jan.kind === 'open') personality = 'delinquent';
  else if (disputes >= 3) personality = 'disputer';
  else if (split || c.jan.kind === 'partial') personality = 'partial';
  else if (quarterEnd) personality = 'quarter_end';
  else if (share((d) => d >= 15 && d <= 24) >= 0.6) personality = 'gamer';
  else personality = medianLate <= ON_TIME_MEDIAN ? 'on_time' : 'slow';

  const ach = c.jan.kind === 'ach_returned' || (c.segment === 'Fintech' && personality !== 'delinquent' && unit(`${c.id}:ach`) < 0.5);
  return {
    clientId: c.id,
    name: c.name,
    personality,
    medianLate,
    rail: ach ? 'ACH' : 'WIRE',
    reference: c.jan.kind === 'lump_sum_no_invoice_refs' ? 'client' : c.jan.kind === 'no_reference' ? 'none' : 'invoices',
    memoName: c.jan.kind === 'no_reference' ? c.jan.memoName : undefined,
    affiliateKey: ds.affiliates.find((a) => a.parentId === c.id)?.key,
    international: c.bank.country !== 'US',
    overpays: c.jan.kind === 'overpaid',
    duplicates: c.jan.kind === 'duplicate_wire',
    typos: TYPO_CLIENTS.has(c.id),
  };
}

export function deriveProfiles(ds: Dataset): Map<string, Profile> {
  return new Map(ds.clients.map((c) => [c.id, deriveProfile(c, ds)]));
}

/**
 * The first day the client would pay this invoice (ISO date), or undefined while it won't yet.
 * `paidCents > 0` means a first installment went out: the rest follows weeks later.
 */
export function readyOn(p: Profile, inv: { id: string; dueOn: IsoDate; paidCents: number }, cure?: CureView): IsoDate | undefined {
  const u = unit(`${p.clientId}:${inv.id}:when`);
  const second = inv.paidCents > 0;
  switch (p.personality) {
    case 'on_time':
      return addDays(inv.dueOn, Math.min(1, Math.round(Math.min(1, p.medianLate) + (u - 0.85) * 6)) + (second ? 10 : 0));
    case 'slow':
      return addDays(inv.dueOn, Math.max(-1, Math.round(0.8 * p.medianLate + (u - 0.5) * Math.max(6, p.medianLate))) + (second ? 10 : 0));
    case 'partial':
      return addDays(inv.dueOn, second ? 32 : 5 + Math.floor(u * 8));
    case 'disputer':
      return addDays(inv.dueOn, 27 + Math.floor(u * 5));
    case 'delinquent':
      return addDays(inv.dueOn, 60 + Math.floor(u * 90) + (second ? 14 : 0));
    case 'quarter_end':
      return quarterEndOnOrAfter(inv.dueOn);
    case 'gamer':
      if (!cure) return undefined;
      return cure.state === 'expired' ? inv.dueOn : addDays(cure.dueOn, -1);
  }
}

/**
 * The day a dispute opened on `inv` on `openedOn` gets its ruling. A serial disputer's lands two
 * days before it would have paid (it then pays right after, as its history shows); a gamer's takes
 * two to three weeks; anyone else's one to two.
 */
export function rulingOn(p: Profile, inv: { id: string; dueOn: IsoDate; paidCents: number }, openedOn: IsoDate): IsoDate {
  const u = unit(`${p.clientId}:${inv.id}:ruling`);
  if (p.personality === 'disputer') {
    const ready = readyOn(p, inv);
    const target = ready ? addDays(ready, -2) : openedOn;
    return target > addDays(openedOn, 12) ? target : addDays(openedOn, 12);
  }
  return addDays(openedOn, (p.personality === 'gamer' ? 15 : 10) + Math.floor(u * 10));
}
