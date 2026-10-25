import { achCollection, achReturn, wireIn } from '../bank-text/format';
import type { Bank } from './bank';
import { PLATFORM_BANK } from './seed-plan';

/**
 * Money arriving at the platform's collections account as the bank would show it, with the other
 * side recorded in the payer's own account when we hold it. Shared by the demo routes and the
 * world engine, so every payment takes the same path: Nessie write, then sync and payment checking.
 */
export interface Payer {
  name: string;
  account: string;
  bank: { name: string; id: string; country: string };
  /** The payer's account at Nessie (seed-map key), when we hold it: its outgoing side is written too. */
  accountKey?: string;
}

export interface IncomingWire {
  trn: string;
  date: string;
  payer: Payer;
  /** What lands in collections (after intermediary charges on an international wire). */
  amountCents: number;
  remittance: string;
  status: 'completed' | 'pending';
  /** International wire: the payer sent `amountCents + chargesCents`. */
  swift?: { chargeBearer: 'SHA' | 'OUR' | 'BEN'; chargesCents: number };
}

export async function postIncomingWire(bank: Bank, platformLegalName: string, w: IncomingWire): Promise<void> {
  const collections = bank.map.accounts.collections;
  if (!collections) throw new Error('collections account missing');
  const description = wireIn({
    trn: w.trn, date: w.date, orig: w.payer.name, origAccount: w.payer.account, bank: w.payer.bank, remittance: w.remittance,
    international: w.swift
      ? { uetr: crypto.randomUUID(), instructedCents: w.amountCents + w.swift.chargesCents, chargeBearer: w.swift.chargeBearer, chargesCents: w.swift.chargesCents }
      : undefined,
  });
  await bank.api.createDeposit(collections.id, { medium: 'balance', transaction_date: w.date, status: w.status, amount: w.amountCents, description });
  const own = w.payer.accountKey ? bank.map.accounts[w.payer.accountKey] : undefined;
  if (own) {
    await bank.api.createWithdrawal(own.id, {
      medium: 'balance', transaction_date: w.date, status: 'completed', amount: w.amountCents + (w.swift?.chargesCents ?? 0),
      description: `WIRE TYPE:FED OUT TRN:${w.trn} BNF:${platformLegalName.toUpperCase()} ID:${collections.number} RCV BK:${PLATFORM_BANK.name} PMT DET:${w.remittance.toUpperCase()}`,
    });
  }
}

export interface AchPayer {
  clientId: string;
  legalName: string;
  account: string;
  accountKey: string;
}

/** We pull the payment from the client's account (CCD debit on auto-debit); both sides are written. */
export async function postAchCollection(
  bank: Bank,
  platformLegalName: string,
  a: { trace: string; date: string; payer: AchPayer; amountCents: number; addenda: string },
): Promise<void> {
  const collections = bank.map.accounts.collections;
  const own = bank.map.accounts[a.payer.accountKey];
  if (!collections || !own) throw new Error(`missing bank account for ${a.payer.accountKey}`);
  await bank.api.createDeposit(collections.id, {
    medium: 'balance', transaction_date: a.date, status: 'completed', amount: a.amountCents,
    description: achCollection({ trace: a.trace, company: a.payer.legalName, account: a.payer.account, individualId: a.payer.clientId.replace('-', ''), addenda: a.addenda }),
  });
  await bank.api.createWithdrawal(own.id, {
    medium: 'balance', transaction_date: a.date, status: 'completed', amount: a.amountCents,
    description: `ACH DEBIT ${platformLegalName.toUpperCase()} CCD TRACE:${a.trace} ADDENDA:${a.addenda}`,
  });
}

/** The client's bank sends an ACH debit back (R01, insufficient funds). */
export async function postAchReturn(
  bank: Bank,
  platformLegalName: string,
  r: { trace: string; originalTrace: string; date: string; payer: AchPayer; amountCents: number },
): Promise<void> {
  const collections = bank.map.accounts.collections;
  const own = bank.map.accounts[r.payer.accountKey];
  if (!collections || !own) throw new Error(`missing bank account for ${r.payer.accountKey}`);
  await bank.api.createWithdrawal(collections.id, {
    medium: 'balance', transaction_date: r.date, status: 'completed', amount: r.amountCents,
    description: achReturn({ trace: r.trace, originalTrace: r.originalTrace, code: 'R01', reason: 'Insufficient funds', company: r.payer.legalName, account: r.payer.account }),
  });
  await bank.api.createDeposit(own.id, {
    medium: 'balance', transaction_date: r.date, status: 'completed', amount: r.amountCents,
    description: `ACH RETURN R01 CREDIT ${platformLegalName.toUpperCase()} TRACE:${r.trace} ORIG TRACE:${r.originalTrace}`,
  });
}
