import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export type Option<T> = { value: T; label: string; hint?: string };

/**
 * A dropdown that looks the same on every OS (the native one opens a dark macOS menu).
 * The list renders into <body> like the row menu, so panels and scroll boxes can't clip it.
 */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>();
  const [hover, setHover] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const open = pos !== undefined;
  const current = options.find((o) => o.value === value);

  const show = () => {
    const r = button.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left, width: r.width });
    setHover(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
  };
  const close = (refocus = true) => {
    setPos(undefined);
    if (refocus) button.current?.focus();
  };
  const choose = (i: number) => {
    onChange(options[i]!.value);
    close();
  };

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !button.current?.contains(t)) close(false);
    };
    // A fixed list would drift from its button, so scrolling or resizing closes it.
    const onMove = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') setHover((h) => Math.min(options.length - 1, h + 1));
    else if (e.key === 'ArrowUp') setHover((h) => Math.max(0, h - 1));
    else if (e.key === 'Home') setHover(0);
    else if (e.key === 'End') setHover(options.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') choose(hover);
    else if (e.key === 'Escape' || e.key === 'Tab') close(e.key === 'Escape');
    else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`select ${open ? 'open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? ''}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            show();
          }
        }}
      >
        <span>{current?.label}</span>
        <svg className="chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M3 4.5 6 7.5 9 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open &&
        createPortal(
          <ul
            ref={list}
            className="menu-list select-list"
            role="listbox"
            aria-label={label}
            aria-activedescendant={`opt-${hover}`}
            tabIndex={-1}
            onKeyDown={onListKey}
            style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
          >
            {options.map((o, i) => (
              <li
                key={String(o.value)}
                id={`opt-${i}`}
                role="option"
                aria-selected={o.value === value}
                className={`${i === hover ? 'hover' : ''} ${o.value === value ? 'selected' : ''}`}
                onMouseEnter={() => setHover(i)}
                onClick={() => choose(i)}
              >
                <span>{o.label}</span>
                {o.hint && <span className="eyebrow">{o.hint}</span>}
                {o.value === value && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    aria-hidden="true"
                    className="check"
                  >
                    <path
                      d="M3 7.5 6 10.5 11 4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
