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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Dec 20" from an ISO date: what a controller says. */
export const day = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''} ${Number(iso.slice(8, 10))}`;

/** One short sentence: trailing full stops and spaces replaced by a single full stop. */
export const sentence = (s: string) => capitalize(`${s.replace(/[.\s]+$/, '')}.`);

/** Reasoning as points, one per "- " line (the console renders them as bullets). Lines past `max` join the last one. */
export function bullets(lines: (string | false | undefined | null)[], max = 4): string {
  const kept = lines.filter((l): l is string => !!l);
  const out = kept.length > max ? [...kept.slice(0, max - 1), kept.slice(max - 1).join(' ')] : kept;
  return out.map((l) => `- ${l}`).join('\n');
}

/** The first point of `bullets` text, without its dash. */
export const firstPoint = (text: string) => (text.split('\n')[0] ?? '').replace(/^- /, '');
