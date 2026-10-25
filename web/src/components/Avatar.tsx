/** A client's initials on a soft colour picked from its id, so the same client always looks the same. */
const TONES = ['blue', 'green', 'amber', 'violet', 'rose', 'teal'] as const;

export function Avatar({ id, name, size = 'sm' }: { id: string; name: string; size?: 'sm' | 'lg' }) {
  const initials = name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`avatar ${size} ${TONES[h % TONES.length]}`} aria-hidden>
      {initials}
    </span>
  );
}
