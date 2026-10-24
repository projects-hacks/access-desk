import type { Dataset } from '../dataset';
import type { Bank } from '../integrations/nessie/bank';
import { formatMemo } from '../integrations/nessie/memo';

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
    description: formatMemo('WIRE OUT', { BENE: client.legalName, BENE_ACCT: to.number, REF: [r.bankRef], ID: id }),
  });
  const into = await bank.api.createDeposit(to.id, {
    medium: 'balance', transaction_date: r.on, status: 'completed', amount: r.amountCents,
    description: formatMemo('WIRE IN', { ORIG: ds.platform.legalName, ORIG_ACCT: from.number, REF: [r.bankRef], ID: id }),
  });
  return { platform: out._id, counterparty: into._id };
}
