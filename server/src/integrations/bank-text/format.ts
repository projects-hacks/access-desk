/**
 * Bank statement text as a US bank shows it: uppercase KEY:VALUE fields,
 * originator names cut to 35 characters, remittance capped at 140 (ISO 20022
 * unstructured remittance) or 80 (ACH addenda). This is what lands in Nessie.
 */
export interface BankRef {
  name: string;
  id: string;
}

const up = (s: string) => s.toUpperCase();
const name35 = (s: string) => up(s).replace(/[^A-Z0-9 &.,-]/g, '').slice(0, 35).trim();
const cap = (s: string, n: number) => up(s).slice(0, n).trim();
const yymmdd = (date: string) => date.slice(2).replace(/-/g, '');
const dollars = (cents: number) => (cents / 100).toFixed(2);

export interface WireIn {
  trn: string;
  date: string;
  orig: string;
  origAccount: string;
  bank: BankRef;
  remittance: string;
  /** International (SWIFT) wires carry the instructed amount and charges. */
  international?: { uetr: string; instructedCents: number; chargeBearer: 'SHA' | 'OUR' | 'BEN'; chargesCents: number };
}

export function wireIn(w: WireIn): string {
  if (w.international) {
    const i = w.international;
    return [
      `WIRE TYPE:INTL IN DATE:${yymmdd(w.date)} TRN:${w.trn} UETR:${i.uetr}`,
      `ORIG:${name35(w.orig)} ID:${w.origAccount} SND BK:${name35(w.bank.name)} ID:${w.bank.id}`,
      `INSTD AMT:USD${dollars(i.instructedCents)} CHGS:${i.chargeBearer} USD${dollars(i.chargesCents)}`,
      `PMT DET:${cap(w.remittance, 140)}`,
    ].join(' ');
  }
  return [
    `WIRE TYPE:FED IN DATE:${yymmdd(w.date)} TRN:${w.trn} IMAD:${w.date.replace(/-/g, '')}MMQFMP2K${w.trn.replace(/\D/g, '').padStart(6, '0')}`,
    `ORIG:${name35(w.orig)} ID:${w.origAccount} SND BK:${name35(w.bank.name)} ID:${w.bank.id}`,
    `PMT DET:${cap(w.remittance, 140)}`,
  ].join(' ');
}

export function wireOut(w: { trn: string; date: string; beneficiary: string; account: string; bank: BankRef; remittance: string }): string {
  return [
    `WIRE TYPE:FED OUT DATE:${yymmdd(w.date)} TRN:${w.trn}`,
    `BNF:${name35(w.beneficiary)} ID:${w.account} RCV BK:${name35(w.bank.name)} ID:${w.bank.id}`,
    `PMT DET:${cap(w.remittance, 140)}`,
  ].join(' ');
}

/** We pulled the money (CCD+ debit); the addenda carries 80 characters. */
export function achCollection(a: { trace: string; company: string; account: string; individualId: string; addenda: string }): string {
  return `ACH CCD DEBIT COLLECTION TRACE:${a.trace} CO:${name35(a.company)} ACCT:${a.account} IND ID:${a.individualId} ADDENDA:${cap(a.addenda, 80)}`;
}

export function achReturn(a: { trace: string; originalTrace: string; code: string; reason: string; company: string; account: string }): string {
  return `ACH RETURN ${a.code} ${up(a.reason)} TRACE:${a.trace} ORIG TRACE:${a.originalTrace} CO:${name35(a.company)} ACCT:${a.account}`;
}

export function analysisFee(f: { trn: string; period: string; wires: number; perWireCents: number }): string {
  return `ACCOUNT ANALYSIS FEE TRN:${f.trn} PERIOD:${f.period} INCOMING WIRES ${f.wires} @ ${dollars(f.perWireCents)}`;
}

/** How a payer writes invoice numbers. Real payers are inconsistent; each client keeps its own habit. */
export type RemittanceStyle = 'spaced' | 'slashed' | 'words' | 'range' | 'swift';

export function invoiceRemittance(ids: string[], style: RemittanceStyle, tail = ''): string {
  const nums = ids.map((id) => id.replace(/^INV-/, ''));
  const consecutive = nums.every((n, i) => i === 0 || Number(n) === Number(nums[i - 1]) + 1);
  let text: string;
  switch (style) {
    case 'spaced': text = nums.map((n) => `INV${n}`).join(' '); break;
    case 'slashed': text = `INV-${nums.join('/')}`; break;
    case 'words': text = nums.length > 1 ? `INVOICES ${nums.slice(0, -1).join(', ')} & ${nums.at(-1)}` : `INVOICE ${nums[0]}`; break;
    case 'range': text = consecutive && nums.length > 1 ? `PMT INV ${nums[0]}-${nums.at(-1)}` : `PMT INV ${nums.join(' ')}`; break;
    case 'swift': text = `/INV/${nums.join(' ')}`; break;
  }
  return tail ? `${text} ${tail}` : text;
}
