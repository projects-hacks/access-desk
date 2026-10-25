import { useEffect, useRef, useState } from 'react';

/** Matches .drawer.leaving in styles.css. */
const SLIDE_MS = 260;

/**
 * Closing a side panel slides it away first and only then unmounts it.
 * Escape collapses it the same way.
 */
export function useSlideClose(onClose: () => void) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(onClose);
  latest.current = onClose;

  const close = () => {
    if (timer.current) return;
    setLeaving(true);
    timer.current = setTimeout(() => latest.current(), SLIDE_MS);
  };

  useEffect(() => {
    // A dropdown inside the panel handles its own Escape first (and prevents the default).
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && close();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(timer.current);
    };
    // close only reads refs, so binding it once is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { leaving, close };
}

/** The › button that collapses a side panel. */
export function CollapseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="collapse"
      onClick={onClick}
      aria-label="Collapse panel"
      title="Collapse (Esc)"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path
          d="M7 4.5 11.5 9 7 13.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
