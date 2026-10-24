import type { Dataset } from '../dataset';
import type { Bank } from '../integrations/nessie/bank';
import { wireIn, wireOut } from '../integrations/bank-text/format';
import { PLATFORM_BANK } from '../integrations/nessie/seed-plan';
import type { BankRefs, InvoiceState } from '../platform/commands';

/**
 * Money the platform sends a client is a real wire at the bank: out of the
 * Disbursements account, into the client's account (both sides recorded).
 * Safe to retry: a wire whose TRN is already on the account is not sent again.
 */
async function wireToClient(
  bank: Bank,
  ds: Dataset,
  w: { trn: string; clientId: string; amountCents: number; on: string; remittance: string },
): Promise<BankRefs> {
  const client = ds.clients.find((c) => c.id === w.clientId);
  const from = bank.map.accounts.disbursements;
  const to = bank.map.accounts[w.clientId];
  if (!client || !from || !to) throw new Error(`${w.trn}: missing client or account for ${w.clientId}`);
  const sent = (txs: { _id: string; description: string }[]) => txs.find((t) => t.description.includes(`TRN:${w.trn} `))?._id;

  const out = sent(await bank.api.listWithdrawals(from.id)) ?? (await bank.api.createWithdrawal(from.id, {
    medium: 'balance', transaction_date: w.on, status: 'completed', amount: w.amountCents,
    description: wireOut({ trn: w.trn, date: w.on, beneficiary: client.legalName, account: to.number, bank: client.bank, remittance: w.remittance }),
  }))._id;
  const into = sent(await bank.api.listDeposits(to.id)) ?? (await bank.api.createDeposit(to.id, {
    medium: 'balance', transaction_date: w.on, status: 'completed', amount: w.amountCents,
    description: wireIn({ trn: w.trn, date: w.on, orig: ds.platform.legalName, origAccount: from.number, bank: PLATFORM_BANK, remittance: w.remittance }),
  }))._id;
  return { platform: out, counterparty: into };
}

export function sendRefund(bank: Bank, ds: Dataset, commandId: string, r: { clientId: string; bankRef: string; amountCents: number; on: string }) {
  return wireToClient(bank, ds, { ...r, trn: `RF-${commandId}`, remittance: `REFUND DUPLICATE PMT ${r.bankRef}` });
}

/** The CW reference is how the module recognizes the wire when the bank feed brings it back. */
export function sendCustodyWithdrawal(bank: Bank, ds: Dataset, w: { clientId: string; withdrawalId: string; amountCents: number; on: string }) {
  const ref = `CW-${w.withdrawalId.padStart(4, '0')}`;
  return wireToClient(bank, ds, { ...w, trn: ref, remittance: `CUSTODY WITHDRAWAL ${ref}` });
}

/** Keeps the invoices presented at the client's bank (Nessie bills) in step with billing. */
export async function syncBills(bank: Bank, ds: Dataset, invoices: InvoiceState[]) {
  for (const s of invoices) {
    const billId = bank.map.bills[s.id];
    const invoice = ds.invoices.find((i) => i.id === s.id);
    if (!billId || !invoice) continue;
    await bank.api.updateBill(billId, { status: s.paidCents >= invoice.amountCents ? 'completed' : 'pending' });
  }
}
