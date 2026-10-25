import { z } from 'zod';

/**
 * The gateway's command contract. Commands are written by reducers in the
 * SpacetimeDB module (as JSON in gateway_command.action_json) and executed by
 * the gateway against the platform's systems of record. Amounts are integer
 * cents; the module serializes them as strings, so both forms are accepted.
 */
const cents = z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).transform(Number);
const date = z.iso.date();

const applicationLine = z.object({ applicationId: z.string(), invoiceId: z.string(), amountCents: cents });
export const journalLine = z.object({ account: z.string(), debitCents: cents, creditCents: cents });

export const GatewayActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('APPLY_PAYMENT'), movementId: z.string(), on: date, applications: z.array(applicationLine).min(1) }),
  z.object({ type: z.literal('REVERSE_PAYMENT'), movementId: z.string(), on: date, applications: z.array(applicationLine).min(1) }),
  z.object({
    type: z.literal('POST_JOURNAL'),
    journal: z.object({ journalId: z.string(), postedOn: date, ref: z.string(), memo: z.string(), lines: z.array(journalLine).min(2) }),
  }),
  z.object({ type: z.literal('PLACE_HOLD'), clientId: z.string(), holdId: z.string(), amountCents: cents, clause: z.string() }),
  z.object({ type: z.literal('RELEASE_HOLD'), clientId: z.string(), holdId: z.string() }),
  z.object({ type: z.literal('SET_LEVER'), clientId: z.string(), lever: z.enum(['withdrawals', 'trading', 'api', 'financing']), state: z.string(), detail: z.string() }),
  z.object({
    type: z.literal('CUSTODY_DEBIT'), clientId: z.string(), amountCents: cents, on: date, invoiceIds: z.array(z.string()).min(1),
    applications: z.array(applicationLine).default([]),
  }),
  z.object({ type: z.literal('CUSTODY_WITHDRAWAL'), clientId: z.string(), withdrawalId: z.string(), amountCents: cents, on: date }),
  z.object({ type: z.literal('REFUND'), clientId: z.string(), movementId: z.string(), bankRef: z.string(), amountCents: cents, on: date }),
  z.object({ type: z.literal('SEND_NOTICE'), clientId: z.string(), channel: z.enum(['email', 'portal', 'rm']), body: z.string(), noticeId: z.string().optional() }),
  z.object({
    type: z.literal('RETURN_PAYMENT'), movementId: z.string(), bankRef: z.string(), platformAccount: z.string(), amountCents: cents,
    origName: z.string(), origAccount: z.string(), on: date,
  }),
  z.object({
    type: z.literal('TRADE'), clientId: z.string(), orderId: z.string(), side: z.enum(['buy', 'sell']), asset: z.string(),
    quantity: z.number().positive(), amountCents: cents,
  }),
]);

export type GatewayAction = z.infer<typeof GatewayActionSchema>;
export type ActionType = GatewayAction['type'];

/** What a system of record reports back after a write; the module applies it to the golden copy. */
export interface InvoiceState { id: string; paidCents: number; paidOn: string | null }
export interface LeverState { id: string; state: string; detail: string }
export interface HoldingState { id: string; quantity: number; valueCents: number }
export interface BankRefs { platform: string; counterparty: string }

export type GatewayResult =
  | { type: 'APPLY_PAYMENT' | 'REVERSE_PAYMENT'; invoices: InvoiceState[] }
  | { type: 'POST_JOURNAL'; journalId: string }
  | { type: 'PLACE_HOLD' | 'RELEASE_HOLD' | 'SET_LEVER'; lever: LeverState }
  | { type: 'CUSTODY_DEBIT'; invoices: InvoiceState[]; holdings: HoldingState[] }
  | { type: 'CUSTODY_WITHDRAWAL'; holdings: HoldingState[]; nessie?: BankRefs }
  | { type: 'REFUND' | 'RETURN_PAYMENT'; nessie: BankRefs }
  | { type: 'SEND_NOTICE'; messageId: string }
  | { type: 'TRADE'; holdings: HoldingState[] };
