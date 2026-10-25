import type { BankMovement, Loan, OnchainPayment, PlantedCase } from './types';

/** Financing lines. Balances are after the movements below. */
export const LOANS: Loan[] = [
  { id: 'LN-2201', clientId: 'ORG-90101', lineCents: 500_000_000, outstandingCents: 350_000_000, openedOn: '2025-06-12' },
  { id: 'LN-2205', clientId: 'ORG-90302', lineCents: 200_000_000, outstandingCents: 75_000_000, openedOn: '2026-02-17' },
  { id: 'LN-2140', clientId: 'ORG-90244', lineCents: 400_000_000, outstandingCents: 200_000_000, openedOn: '2025-03-04' },
  // Restricted client: no new borrowing allowed while invoices are overdue.
  { id: 'LN-2188', clientId: 'ORG-90802', lineCents: 30_000_000, outstandingCents: 25_000_000, openedOn: '2025-11-14' },
];

type LoanMovement = Omit<BankMovement, 'id'>;

export const LOAN_MOVEMENTS: LoanMovement[] = [
  {
    kind: 'loan_disbursement', rail: 'WIRE', direction: 'out', platformAccount: 'disbursements',
    party: { type: 'client', id: 'ORG-90101' }, amountCents: 200_000_000, valueDate: '2026-02-09',
    status: 'completed', refs: ['LN-2201'],
  },
  {
    kind: 'loan_disbursement', rail: 'WIRE', direction: 'out', platformAccount: 'disbursements',
    party: { type: 'client', id: 'ORG-90302' }, amountCents: 75_000_000, valueDate: '2026-02-17',
    status: 'completed', refs: ['LN-2205'],
  },
  {
    kind: 'loan_repayment', rail: 'WIRE', direction: 'in', platformAccount: 'collections',
    party: { type: 'client', id: 'ORG-90244' }, amountCents: 100_000_000, valueDate: '2026-02-24',
    status: 'completed', refs: ['LN-2140'],
  },
];

/** USDC from a wallet that isn't mapped to any client. */
export const UNKNOWN_WALLET_PAYMENT: OnchainPayment = {
  txHash: '0x5e2f9a0c7b1d43e8a6f2c9d0b7e4a1f3c8d2e6b9a0f7c4d1e8b3a6f9c2d5e0a7',
  wallet: '0xa47d2c19e8b05f3a6c7d9e1b2f4a8c0d3e5f7b9c',
  amountCents: 500_000,
  asset: 'USDC',
  valueDate: '2026-03-02',
  refs: [],
  caseId: 'unknown-wallet',
};

/** Answer key: what the system must do with each planted situation. */
export const CASES: PlantedCase[] = [
  { id: 'custody-debit', clientId: 'ORG-90233', demoStep: 2, title: 'Fees owed, custody balance available', expected: 'Debit the overdue fees from custody under the contract; no restriction.' },
  { id: 'disputed-invoice', clientId: 'ORG-90412', demoStep: 3, title: 'Disputed API overage', expected: 'Exclude the disputed invoice from the amount held.' },
  { id: 'demo-affiliate-wire', clientId: 'ORG-90412', demoStep: 6, title: 'General partner wires the overdue amount', expected: 'Map Zephyr Capital Mgmt LP to Kestrel via the CRM, apply to the three open January invoices, release the hold within seconds.' },
  { id: 'novel-case', clientId: 'ORG-90355', demoStep: 7, title: 'Client being acquired', expected: 'No policy covers it: investigate, act within the contract, and log the reasoning; it only waits if the agent is under 10% sure.' },
  { id: 'affiliate-wire', clientId: 'ORG-90244', title: 'Feeder fund pays for the client', expected: 'Map Basalt GM Feeder Ltd to Basalt Global Macro and apply.' },
  { id: 'short-wire', clientId: 'ORG-90431', title: 'International wire arrives $25.00 short (SHA charges)', expected: 'The wire reports instructed $X and $25.00 intermediary charges: apply in full and write off $25.00 to bank fees (pol-002).' },
  { id: 'lump-sum', clientId: 'ORG-90229', title: 'Catch-up wire with only the client id as reference', expected: 'Find the set of open invoices that sums to the wire and apply to all of them.' },
  { id: 'no-reference', clientId: 'ORG-90366', title: 'Wire with no reference and an abbreviated name', expected: 'Identify the payer by originator account number and match on amount.' },
  { id: 'paid-not-applied', clientId: 'ORG-90612', title: 'Shows overdue, but the cash arrived Feb 19 (described in words, no invoice numbers)', expected: 'Read the remittance (January custody and trading), apply it, drop any restriction proposal.' },
  { id: 'partial-payment', clientId: 'ORG-90744', title: 'Half of one invoice paid', expected: 'Apply the partial amount; aging continues on the remaining balance.' },
  { id: 'in-transit', clientId: 'ORG-90463', title: 'Wire sent, not yet posted', expected: 'Do not restrict while the payment is in transit; act only on posted funds.' },
  { id: 'ach-return', clientId: 'ORG-90689', title: 'ACH auto-debit returned R01 (insufficient funds) after billing applied it', expected: 'Reverse the application, book the return, reopen the invoice.' },
  { id: 'onchain-payment', clientId: 'ORG-90164', title: 'Paid in USDC on-chain', expected: 'Match the USDC transfer from the known wallet to the open invoices.' },
  { id: 'unknown-wallet', clientId: '', title: 'USDC from an unknown wallet', expected: 'Park the cash as unapplied and log it; restrict no one, ask no one.' },
  { id: 'overpayment', clientId: 'ORG-90176', title: 'Wire $1,000.00 more than owed', expected: 'Apply to the invoices and hold the excess as credit on account.' },
  { id: 'duplicate-wire', clientId: 'ORG-90391', title: 'Same wire sent twice', expected: 'Apply the first, flag the second as a duplicate and keep it as credit on the account; no approval.' },
  { id: 'wrong-reference', clientId: 'ORG-90251', title: "Quotes February's invoice numbers, pays January's amount", expected: 'Match to the open January invoices by amount; leave February open.' },
  { id: 'new-bank-account', clientId: 'ORG-90378', title: 'Pays from an account never seen before', expected: 'Match by name and amount at lower confidence, apply it, and add the account to the CRM; no approval.' },
  { id: 'dispute-to-delay', clientId: 'ORG-90518', title: 'Serial disputer: every invoice disputed, every dispute upheld, paid two days after each resolution', expected: 'Disputed invoices are not in default, so the cure period ends "met" with nothing paid. Spot the pattern in the history and propose a fix to the tier guidelines (for example prepay after repeated upheld disputes); the fix waits for a controller. Do not collect disputed amounts.' },
  { id: 'cure-withdrawal', clientId: 'ORG-90412', title: 'Client in its cure period withdraws custody cash (live: POST /demo/withdraw)', expected: 'Honor the withdrawal (no restriction before the cure period ends, §9.1), flag it as an exploit (an alert, no approval), and hold under §7.2 once the cure period expires.' },
  { id: 'strategic-client', clientId: 'ORG-90101', title: 'Strategic client', expected: 'Restricting it always waits for a controller; everything else (reminders, matching) runs as usual.' },
];
