import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * A highlight that slides to whichever sibling has data-active="true". Render it as the
 * first child of a position: relative row; the row's buttons sit above it (see .slider).
 * `active` is only a dependency: pass the selected key so the pill moves when it changes.
 */
export function SlidingPill({ active, className = '' }: { active: string; className?: string }) {
  const self = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 });
  const placed = useRef(false);

  useLayoutEffect(() => {
    // Its own parent, not a ref from the parent: a parent's ref isn't attached yet when this runs.
    const row = self.current?.parentElement;
    if (!row) return;
    const place = () => {
      const target = row.querySelector<HTMLElement>('[data-active="true"]');
      if (!target) {
        setStyle((s) => ({ ...s, opacity: 0 }));
        return;
      }
      setStyle({
        width: target.offsetWidth,
        height: target.offsetHeight,
        transform: `translate(${target.offsetLeft}px, ${target.offsetTop}px)`,
        opacity: 1,
        // Appear in place the first time; slide on every change after that.
        transition: placed.current ? undefined : 'none',
      });
      placed.current = true;
    };
    place();
    // Counts and wrapping change button sizes without changing the selection.
    const ro = new ResizeObserver(place);
    ro.observe(row);
    for (const child of row.children) ro.observe(child);
    return () => ro.disconnect();
  }, [active]);

  return <span ref={self} className={`slider ${className}`} style={style} aria-hidden="true" />;
}
