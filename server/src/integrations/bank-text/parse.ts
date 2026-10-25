/**
 * Reads bank statement text back into standard fields. Deterministic and
 * explainable: every field says where it came from. Free text with no
 * recognizable references is left for Claude (interpret.ts).
 */
export type Category = 'wire_in' | 'wire_out' | 'ach_collection' | 'ach_return' | 'fee' | 'unknown';

export interface ParsedBankText {
  category: Category;
  network: 'FEDWIRE' | 'SWIFT' | 'ACH' | 'BOOK' | 'UNKNOWN';
  bankRef?: string;
  counterpartyName?: string;
  counterpartyAccount?: string;
  counterpartyBank?: string;
  remittance: string;
  refs: string[];
  instructedCents?: number;
  chargesCents?: number;
  chargeBearer?: 'SHA' | 'OUR' | 'BEN';
  returnCode?: string;
  reverses?: string;
  /** 1 = every field found; lower when references had to be repaired or nothing was found. */
  confidence: number;
  notes: string[];
}

const KEYS = ['WIRE TYPE', 'DATE', 'TRN', 'IMAD', 'UETR', 'ORIG TRACE', 'ORIG', 'SND BK', 'RCV BK', 'BNF', 'ID', 'INSTD AMT', 'CHGS', 'CO', 'ACCT', 'IND ID', 'TRACE', 'PERIOD', 'PMT DET', 'ADDENDA'];
const KEY_RE = new RegExp(`\\b(${KEYS.map((k) => k.replace(' ', '\\s')).join('|')}):`, 'g');

/** Splits `KEY:VALUE KEY:VALUE …` keeping order (ID means different things after ORIG and after SND BK). */
function fields(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const matches = [...text.matchAll(KEY_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const key = m[1]!.replace(/\s+/, ' ');
    const start = m.index! + m[0].length;
    // Remittance runs to the end of the line, whatever it contains.
    if (key === 'PMT DET' || key === 'ADDENDA') {
      out.push([key, text.slice(start).trim()]);
      break;
    }
    out.push([key, text.slice(start, matches[i + 1]?.index ?? text.length).trim()]);
  }
  return out;
}

const cents = (s: string | undefined) => {
  const m = s?.match(/USD\s*([\d,]+\.\d{2})/);
  return m ? Math.round(Number(m[1]!.replace(/,/g, '')) * 100) : undefined;
};

/** Repairs OCR-style slips inside numbers: letter O → 0, I/L → 1. */
const digits = (s: string) => s.replace(/O/g, '0').replace(/[IL]/g, '1');

/** Invoice, client, loan, payment and custody withdrawal references, normalized (INV-1050, ORG-90412, LN-2201, WI-5404, CW-0001). */
export function extractRefs(remittance: string): { refs: string[]; repaired: boolean } {
  const text = ` ${remittance.toUpperCase().replace(/\/INV\//g, ' INV ').replace(/\bINVOICES?\b/g, 'INV')} `;
  const refs = new Set<string>();
  let repaired = false;
  const num = '[0-9OIL]{4}';
  const group = new RegExp(`INV[-\\s#:]*(${num}(?:\\s*-\\s*${num})?(?:\\s*(?:,|&|\\/|AND|\\s)\\s*${num}(?:\\s*-\\s*${num})?)*)`, 'g');
  for (const m of text.matchAll(group)) {
    for (const part of m[1]!.split(/\s*(?:,|&|\/|AND|\s)\s*/).filter(Boolean)) {
      const [a, b] = part.split(/\s*-\s*/).map((x) => { const d = digits(x); if (d !== x) repaired = true; return Number(d); });
      if (a === undefined || Number.isNaN(a)) continue;
      const to = b !== undefined && b >= a && b - a < 25 ? b : a;
      for (let n = a; n <= to; n++) refs.add(`INV-${n}`);
    }
  }
  for (const m of text.matchAll(/\bORG[-\s]?(\d{5})\b/g)) refs.add(`ORG-${m[1]}`);
  for (const m of text.matchAll(/\bLN[-\s]?(\d{4})\b/g)) refs.add(`LN-${m[1]}`);
  for (const m of text.matchAll(/\b(WI|AC|TX|CW|JD)-(\d{4})\b/g)) refs.add(`${m[1]}-${m[2]}`);
  for (const m of text.matchAll(/\bWE-(\d{5})\b/g)) refs.add(`WE-${m[1]}`);
  return { refs: [...refs], repaired };
}

export function parseBankText(raw: string): ParsedBankText {
  const text = raw.toUpperCase();
  const f = fields(text);
  const get = (k: string) => f.find(([key]) => key === k)?.[1];
  const idAfter = (k: string) => {
    const i = f.findIndex(([key]) => key === k);
    return i >= 0 && f[i + 1]?.[0] === 'ID' ? f[i + 1]![1] : undefined;
  };
  const notes: string[] = [];
  const base = { refs: [] as string[], remittance: '', confidence: 1, notes };

  let parsed: ParsedBankText;
  const wireType = get('WIRE TYPE');
  if (wireType === 'FED IN' || wireType === 'INTL IN') {
    const chgs = get('CHGS');
    parsed = {
      ...base, category: 'wire_in', network: wireType === 'FED IN' ? 'FEDWIRE' : 'SWIFT', bankRef: get('TRN'),
      counterpartyName: get('ORIG'), counterpartyAccount: idAfter('ORIG'), counterpartyBank: get('SND BK'),
      remittance: get('PMT DET') ?? '', instructedCents: cents(get('INSTD AMT')), chargesCents: cents(chgs),
      chargeBearer: chgs?.match(/^(SHA|OUR|BEN)/)?.[1] as ParsedBankText['chargeBearer'],
    };
  } else if (wireType === 'FED OUT') {
    parsed = {
      ...base, category: 'wire_out', network: 'FEDWIRE', bankRef: get('TRN'), counterpartyName: get('BNF'),
      counterpartyAccount: idAfter('BNF'), counterpartyBank: get('RCV BK'), remittance: get('PMT DET') ?? '',
    };
  } else if (text.startsWith('ACH CCD DEBIT COLLECTION')) {
    parsed = {
      ...base, category: 'ach_collection', network: 'ACH', bankRef: get('TRACE'), counterpartyName: get('CO'),
      counterpartyAccount: get('ACCT'), remittance: get('ADDENDA') ?? '',
    };
  } else if (text.startsWith('ACH RETURN')) {
    parsed = {
      ...base, category: 'ach_return', network: 'ACH', bankRef: get('TRACE'), reverses: get('ORIG TRACE'),
      returnCode: text.match(/^ACH RETURN (R\d{2})/)?.[1], counterpartyName: get('CO'), counterpartyAccount: get('ACCT'),
    };
  } else if (text.startsWith('ACCOUNT ANALYSIS FEE')) {
    parsed = { ...base, category: 'fee', network: 'BOOK', bankRef: get('TRN'), counterpartyName: 'BANK FEES', remittance: get('PERIOD') ?? '' };
  } else {
    return { ...base, category: 'unknown', network: 'UNKNOWN', remittance: text, confidence: 0, notes: ['Unrecognized statement format'] };
  }

  const { refs, repaired } = extractRefs(parsed.remittance);
  parsed.refs = refs;
  if (repaired) {
    parsed.confidence = 0.9;
    notes.push('Invoice number had a typo (letter for digit); repaired');
  }
  if (!parsed.bankRef) {
    parsed.confidence = Math.min(parsed.confidence, 0.5);
    notes.push('No bank reference');
  }
  if (parsed.category === 'wire_in' && !refs.length) {
    notes.push(parsed.remittance ? 'Remittance has no invoice or client references' : 'No remittance information');
  }
  return parsed;
}
