import { useEffect, useState } from 'react';

/** The ring mark, drawn once so the loader's sheen can be masked to its exact shape. */
const RING =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='24' fill='none' stroke='black' stroke-width='14'/%3E%3C/svg%3E";

/** Shortest time the loader stays up, so the sheen reads as intentional rather than a flicker. */
const MIN_MS = 900;
/** Matches the .splash fade-out in styles.css. */
const FADE_MS = 300;

/**
 * Full-screen logo with a light band sweeping across it until `ready`, then a quick fade.
 * The page underneath staggers in with .reveal (see styles.css).
 */
export function Splash({ ready, onLeave }: { ready: boolean; onLeave: () => void }) {
  const [minDone, setMinDone] = useState(false);
  const [phase, setPhase] = useState<'loading' | 'leaving' | 'gone'>('loading');

  useEffect(() => {
    const t = setTimeout(() => setMinDone(true), MIN_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!ready || !minDone || phase !== 'loading') return;
    setPhase('leaving');
    onLeave();
  }, [ready, minDone, phase, onLeave]);

  // Separate from the effect above so a new onLeave from the parent can't cancel the fade.
  useEffect(() => {
    if (phase !== 'leaving') return;
    const t = setTimeout(() => setPhase('gone'), FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === 'gone') return null;
  return (
    <div
      className="splash"
      data-leaving={phase === 'leaving' || undefined}
      role="status"
      aria-label="Loading Neo"
    >
      <span className="splash-logo">
        <img src={RING} alt="" />
        <span
          className="splash-sheen"
          style={{ maskImage: `url("${RING}")`, WebkitMaskImage: `url("${RING}")` }}
          aria-hidden="true"
        >
          <span className="splash-band" />
        </span>
      </span>
    </div>
  );
}
