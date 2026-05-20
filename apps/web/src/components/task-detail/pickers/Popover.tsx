import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@nockta/ui';

import { PILL_CLASS } from '../constants';

export function ValuePill({
  open,
  onClick,
  leading,
  children,
  muted,
  showCaret = true,
}: {
  open?: boolean;
  onClick: () => void;
  leading?: React.ReactNode;
  children: React.ReactNode;
  muted?: boolean;
  showCaret?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      data-open={open ? 'true' : 'false'}
      onClick={onClick}
      className={cn(PILL_CLASS, muted && 'text-muted-foreground/80')}
    >
      {leading}
      <span className="truncate">{children}</span>
      {showCaret && (
        <ChevronDown
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform duration-150',
            open && 'rotate-180',
          )}
        />
      )}
    </button>
  );
}

/* -----------------------------------------------------------------------------
 * Popover — small reusable wrapper. Anchored to the trigger via wrapping
 * <div>; outside-click closes via a transparent fixed scrim (same pattern
 * used elsewhere in this file). Animates with .animate-popover-in.
 * -------------------------------------------------------------------------- */

/**
 * PopoverShell — renders into a document.body portal so it escapes any
 * overflow-clipping ancestors (the task modal has overflow-hidden, plus the
 * main pane scrolls). Anchors itself to the closest positioned ancestor by
 * placing an invisible sentinel `<span>` and reading its parent's bounding
 * rect on every open + window resize + nested scroll.
 *
 * Auto-handles two viewport overflow cases:
 *   - Right edge: if the popover would exceed the viewport, it shifts left.
 *   - Bottom edge: max-height is clamped to the remaining viewport so the
 *     popover scrolls internally instead of being cropped by the modal.
 */
export function PopoverShell({
  open,
  onClose,
  children,
  align = 'right',
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}): JSX.Element | null {
  const anchorSentinelRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const sentinel = anchorSentinelRef.current;
    const triggerEl = sentinel?.parentElement;
    if (!triggerEl) return;

    function reposition(): void {
      if (!triggerEl) return;
      const rect = triggerEl.getBoundingClientRect();
      // Position 6px below the trigger.
      const top = rect.bottom + 6;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Estimate width; we'll re-measure after first paint if needed.
      const popoverWidth = popoverRef.current?.offsetWidth ?? 280;
      // Left/right alignment relative to the trigger.
      let left = align === 'right' ? rect.right - popoverWidth : rect.left;
      // Clamp horizontally to the viewport (8px gutter).
      left = Math.max(8, Math.min(left, vw - popoverWidth - 8));
      // Clamp vertically — leave room for breathing space at the bottom.
      const maxHeight = Math.max(120, vh - top - 16);
      setCoords({ top, left, maxHeight });
    }

    reposition();
    // Re-measure on the next frame to get an accurate width once the
    // popover has rendered its actual content.
    const raf = window.requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, align]);

  // ESC closes — kept here so every picker doesn't need its own listener.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // The sentinel is always rendered so we always have a DOM anchor to read
  // the trigger's position from, even before `open` flips.
  return (
    <>
      <span ref={anchorSentinelRef} className="hidden" aria-hidden="true" />
      {open && coords &&
        createPortal(
          <>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              // Picker layers must sit ABOVE the task drawer (z-[70]),
              // otherwise the popover renders behind the drawer overlay
              // and clicks land on the scrim that closes it — exactly the
              // "dropdowns not working" symptom. The earlier drawer bump
              // moved the drawer from z-[50] to z-[70] but left the
              // pickers at 60/61; this restores the ordering invariant
              // (popover content > popover scrim > drawer overlay).
              className="fixed inset-0 z-[80] cursor-default bg-transparent"
            />
            <div
              ref={popoverRef}
              className={cn(
                'animate-popover-in fixed z-[81] min-w-[200px] rounded-md border border-border bg-popover shadow-xl shadow-black/40 overflow-auto',
                className,
              )}
              style={{
                top: coords.top,
                left: coords.left,
                maxHeight: coords.maxHeight,
                transformOrigin: align === 'right' ? 'top right' : 'top left',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {children}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

export function PopoverList({
  children,
  maxHeight = 'max-h-72',
}: {
  children: React.ReactNode;
  maxHeight?: string;
}): JSX.Element {
  return (
    <ul className={cn('overflow-y-auto p-1 stagger-list', maxHeight)}>
      {children}
    </ul>
  );
}

export function PopoverItem({
  selected,
  onClick,
  children,
}: {
  selected?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <li className="stagger-item">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'tap w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-left',
          'hover:bg-accent/60 transition-colors duration-150',
          selected && 'bg-accent/40',
        )}
      >
        <span className="flex-1 min-w-0 flex items-center gap-2">{children}</span>
        {selected && <Check className="h-3 w-3 text-brand shrink-0" />}
      </button>
    </li>
  );
}
