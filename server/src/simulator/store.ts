import type { Product } from '../domain';

export interface Invoice {
  id: string;
  clientId: string;
  product: Product;
  amountCents: number;
  paidCents: number;
  dueAt: string;
  updatedAt: string;
}

export interface Restriction {
  clientId: string;
  product: Product;
  step: string;
}

export interface LedgerEntry {
  debitAccount: string;
  creditAccount: string;
  amountCents: number;
  memo: string;
  at: string;
}

/** In-memory systems of record for the demo platform. TODO: load from seed data. */
export const store = {
  invoices: new Map<string, Invoice>(),
  restrictions: new Map<string, Restriction>(),
  ledger: [] as LedgerEntry[],
};
