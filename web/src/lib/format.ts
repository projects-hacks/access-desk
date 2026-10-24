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
