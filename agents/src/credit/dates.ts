/** Sim dates are `YYYY-MM-DD` strings; these work on whole days in UTC. */
const DAY_MS = 86_400_000;

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string) => Math.round((ms(to) - ms(from)) / DAY_MS);

export const addDays = (d: string, n: number) => new Date(ms(d) + n * DAY_MS).toISOString().slice(0, 10);

export const maxDate = (a: string, b: string) => (a >= b ? a : b);
