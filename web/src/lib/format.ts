const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdShort = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Amounts are integer cents (bigint from the database). */
export function money(cents: bigint | number, short = false): string {
  const dollars = Number(cents) / 100;
  return (short ? usdShort : usd).format(dollars);
}

/** Sim dates are 'YYYY-MM-DD'; shown as 'Tue, Mar 3, 2026'. */
export function simDay(date: string | undefined): string {
  if (!date) return '…';
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** 'PAYMENT_MATCH' → 'Payment match'. */
export function label(code: string): string {
  const s = code.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** JSON columns hold strings; bad JSON shows as empty rather than crashing a screen. */
export function parseJson<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Dates inside a sentence: '2026-03-14' becomes 'Mar 14'. */
export function plainDates(text: string): string {
  return text.replace(/\b\d{4}-(\d{2})-(\d{2})\b/g, (_all, m: string, d: string) => `${MONTHS[+m - 1] ?? m} ${+d}`);
}

/**
 * Display safety net for text the module or an agent wrote: dates become "Mar 14", client ids become
 * names, snake_case becomes words, a client's own policy key reads "this client's own policy", and
 * policy, work item, score and section references are dropped. "Acme Corp: Acme: ..." keeps one prefix.
 */
export function plainText(text: string, names: Map<string, string> = new Map()): string {
  const out = plainDates(text)
    .replace(/\bpol-\d+:ORG-\d+\b/gi, "this client's own policy")
    .replace(/\bORG-\d+\b/g, (id) => names.get(id) ?? 'the client')
    .replace(/\bpol-\d+\b/gi, 'policy')
    .replace(/\bWI-\d+\b/g, 'this request')
    .replace(/\s*·?\s*\bscores? \d+(\.\d+)?/gi, '')
    .replace(/\s*\(?§\s*[\d.]+\)?/g, '')
    .replace(/\b[A-Z]+(?:_[A-Z]+)+\b/g, (w) => w.toLowerCase().replace(/_/g, ' '))
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (w) => w.replace(/_/g, ' '))
    .replace(/\(([A-Z]{3,}(?:, [A-Z]{3,})*)\)/g, (_all, w: string) => `(${w.toLowerCase()})`)
    .replace(/\bapi\b/gi, 'API')
    .replace(/^([^:]{2,60}): ([^:]{2,60}): /, (all, a: string, b: string) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x.startsWith(y) || y.startsWith(x) ? `${a.length >= b.length ? a : b}: ` : all;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}
