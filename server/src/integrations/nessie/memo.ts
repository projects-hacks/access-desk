/**
 * Bank memo format. Nessie has no counterparty fields, so the originator,
 * account and references travel in `description`, the way remittance info
 * does on a real wire. Payment checking parses this back with parseMemo.
 *
 *   WIRE IN | ORIG: Kestrel Quant LP | ORIG_ACCT: 4410220791334512 | REF: INV-1057 INV-1061 | ID: WI-5531
 */
export interface Memo {
  type: string;
  fields: Record<string, string>;
}

export function formatMemo(type: string, fields: Record<string, string | string[] | undefined>): string {
  const parts = [type];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(' ') : value;
    if (text) parts.push(`${key}: ${text}`);
  }
  return parts.join(' | ');
}

export function parseMemo(description: string): Memo {
  const [type = '', ...rest] = description.split(' | ');
  const fields: Record<string, string> = {};
  for (const part of rest) {
    const i = part.indexOf(': ');
    if (i > 0) fields[part.slice(0, i)] = part.slice(i + 2);
  }
  return { type, fields };
}

export function memoRefs(memo: Memo): string[] {
  return memo.fields.REF?.split(' ').filter(Boolean) ?? [];
}
