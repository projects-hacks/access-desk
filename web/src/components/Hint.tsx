import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const MARGIN = 8;
const GAP = 6;

/**
 * A small popover for a name or chip: opens on hover and keyboard focus, on tap where there is no
 * hover, and closes on Escape or an outside tap. It is portalled and clamped into the viewport so
 * the docked panel's edge or a phone screen never cuts it off.
 */
export function Hint({ title, role, about, status, className, children }: {
  title: string;
  role?: string;
  about: string;
  status?: string;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>();

  // Place it below the anchor, flipped above when there is no room, and keep it inside the viewport.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !pop.current) return;
    const a = anchor.current.getBoundingClientRect();
    const p = pop.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const left = Math.max(MARGIN, Math.min(a.left, vw - p.width - MARGIN));
    const below = a.bottom + GAP;
    const top = below + p.height + MARGIN > vh && a.top - GAP - p.height > MARGIN ? a.top - GAP - p.height : below;
    setPos({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Closing the tip is all Escape does here.
      e.stopPropagation();
      close();
    };
    const onDown = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown);
    // A scroll moves the anchor out from under the popover.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const show = () => {
    setPos(undefined);
    setOpen(true);
  };
  const touch = () => window.matchMedia('(hover: none)').matches;

  return (
    <>
      <span
        ref={anchor}
        className={`hint ${className ?? ''}`}
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => !touch() && show()}
        onMouseLeave={() => !touch() && setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={() => touch() && !open && show()}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={pop}
            id={id}
            role="tooltip"
            className="hint-pop"
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          >
            <strong>{title}</strong>
            {role && <span className="hint-role">{role}</span>}
            <p>{about}</p>
            {status && <span className="hint-status">{status}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
