/**
 * Bank references for what the world sends. Payment checking recognizes a referenced payment
 * (a refund names the wire it sends back) only as WI-nnnn or AC-nnnn, so wires use WI-6000..9999
 * and ACH uses AC-8000..9999 (the dataset's are WI-54xx and AC-71xx). If a range runs out,
 * references continue as WE-nnnnn: still unique, but a duplicate refund can no longer name the wire.
 */
const RANGES = {
  wire: { prefix: 'WI', from: 6000, to: 9999 },
  ach: { prefix: 'AC', from: 8000, to: 9999 },
} as const;

export type RefKind = keyof typeof RANGES;

const WORLD_REF = /^(?:WI-[6-9]\d{3}|AC-[89]\d{3}|WE-\d{5,})$/;

export const isWorldRef = (ref: string) => WORLD_REF.test(ref);

/** The next reference above every one already used (database, bank, this process). */
export function nextRef(kind: RefKind, used: Iterable<string>): string {
  const { prefix, from, to } = RANGES[kind];
  const own = new RegExp(`^${prefix}-(\\d{4})$`);
  let max = from - 1;
  let overflow = 0;
  for (const ref of used) {
    const n = own.exec(ref)?.[1];
    if (n !== undefined && Number(n) >= from) max = Math.max(max, Number(n));
    const w = /^WE-(\d{5,})$/.exec(ref)?.[1];
    if (w !== undefined) overflow = Math.max(overflow, Number(w));
  }
  if (overflow === 0 && max < to) return `${prefix}-${max + 1}`;
  return `WE-${String(overflow + 1).padStart(5, '0')}`;
}
