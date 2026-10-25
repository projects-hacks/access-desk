/** "$1,234.50" from cents. */
export const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "$310,000" for whole dollars, else with cents: for the panel, where trailing zeros are noise. */
export const usdShort = (cents: number) => (cents % 100 === 0 ? usd(cents).slice(0, -3) : usd(cents));

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** "a", "a and b", "a, b and c". */
export const listed = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
