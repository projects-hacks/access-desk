import type { Dataset } from '../dataset';
import type { Bank } from '../integrations/nessie/bank';
import { wireIn, wireOut } from '../integrations/bank-text/format';
import { PLATFORM_BANK } from '../integrations/nessie/seed-plan';

/**
 * Refunds are real money movements at the bank: a wire out of the platform's
 * Disbursements account, landing in the client's account (both sides recorded).
 */
export async function sendRefund(
  bank: Bank,
  ds: Dataset,
  commandId: string,
  r: { clientId: string; bankRef: string; amountCents: number; on: string },
): Promise<{ platform: string; counterparty: string }> {
  const client = ds.clients.find((c) => c.id === r.clientId);
  const from = bank.map.accounts.disbursements;
  const to = bank.map.accounts[r.clientId];
  if (!client || !from || !to) throw new Error(`refund ${commandId}: missing client or account for ${r.clientId}`);
  const id = `RF-${commandId}`;
  const out = await bank.api.createWithdrawal(from.id, {
    medium: 'balance', transaction_date: r.on, status: 'completed', amount: r.amountCents,
    description: wireOut({ trn: id, date: r.on, beneficiary: client.legalName, account: to.number, bank: client.bank, remittance: `REFUND DUPLICATE PMT ${r.bankRef}` }),
  });
  const into = await bank.api.createDeposit(to.id, {
    medium: 'balance', transaction_date: r.on, status: 'completed', amount: r.amountCents,
    description: wireIn({ trn: id, date: r.on, orig: ds.platform.legalName, origAccount: from.number, bank: PLATFORM_BANK, remittance: `REFUND DUPLICATE PMT ${r.bankRef}` }),
  });
  return { platform: out._id, counterparty: into._id };
}
