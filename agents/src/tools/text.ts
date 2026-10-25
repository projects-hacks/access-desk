/** Anything shown to people: short plain sentences, no em dashes, no semicolons. */
export function plain(text: string): string {
  const t = text
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s*;\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/\.\s+([a-z])/g, (_m, c: string) => `. ${c.toUpperCase()}`)
    .trim();
  return t;
}

/**
 * A reason as points, one per "- " line (the console renders them as bullets): lines the agent
 * already wrote that way, else its sentences, at most four.
 */
export function plainPoints(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const raw = lines.length > 1 && lines.every((l) => l.startsWith('- ')) ? lines.map((l) => l.slice(2)) : plain(lines.join(' ')).split(/(?<=[a-z0-9)%$][.!?])\s+(?=[A-Z$])/);
  const clean = raw.map((l) => plain(l)).filter(Boolean);
  const kept = clean.length > 4 ? [...clean.slice(0, 3), clean.slice(3).join(' ')] : clean;
  return kept.map((l) => `- ${l}`).join('\n');
}

/** The agent's last words as one short plain sentence or two: no markdown, no lists, at most about 300 characters. */
export function finalWords(text: string): string {
  const flat = plain(text.replace(/\*\*|`/g, '').split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean).join(' '));
  if (flat.length <= 300) return flat;
  const cut = flat.slice(0, 300);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.'));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.trimEnd()}...`;
}

export const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Tool results are compact JSON; empty values are dropped so the model reads less. */
export function json(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) ? undefined : v));
}
