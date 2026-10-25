import type { Client } from '../dataset';
import { invoiceRemittance } from '../integrations/bank-text/format';
import { styleFor, withTypo } from '../integrations/nessie/seed-plan';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** '2026-02' -> 'FEB26' */
const periodTag = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1]}${period.slice(2, 4)}`;

/**
 * What the payer writes in the remittance field, in each client's own habit (the style of its
 * seeded wires): invoice numbers, only its client id (catch-up wires, general partners), or nothing.
 */
export function remittanceText(
  p: { reference: 'invoices' | 'client' | 'none'; invoiceIds: string[]; payer: 'client' | 'affiliate'; typo: boolean },
  client: Pick<Client, 'id'>,
  payerCountry: string,
  period: string,
): string {
  if (p.reference === 'none') return '';
  if (p.reference === 'client') return p.payer === 'affiliate' ? `REF ${client.id} PER WIRE INSTRUCTIONS` : `${client.id.replace('-', '')} CATCH UP ${periodTag(period)}`;
  const international = payerCountry !== 'US';
  const text = invoiceRemittance(p.invoiceIds, international ? 'swift' : styleFor(client.id), international ? `/RFB/${periodTag(period)}` : '');
  return p.typo ? withTypo(text) : text;
}
