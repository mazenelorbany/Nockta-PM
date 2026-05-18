import { Check } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@nockta/ui';

// =============================================================================
// Portal popover — same pattern as TaskDetailDrawer's PopoverShell. Anchors
// to a passed-in trigger ref, positions below it, clamps to viewport.
// =============================================================================

export function FilterPopover({
  open,
  onClose,
  triggerRef,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement>;
  children: React.ReactNode;
  className?: string;
}): JSX.Element | null {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const triggerEl = triggerRef.current;
    if (!triggerEl) return;

    function reposition(): void {
      if (!triggerEl) return;
      const rect = triggerEl.getBoundingClientRect();
      const top = rect.bottom + 6;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const popoverWidth = popoverRef.current?.offsetWidth ?? 240;
      // Align left edge with trigger by default; clamp to viewport.
      let left = rect.left;
      left = Math.max(8, Math.min(left, vw - popoverWidth - 8));
      const maxHeight = Math.max(120, vh - top - 16);
      setCoords({ top, left, maxHeight });
    }

    reposition();
    const raf = window.requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, triggerRef]);

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

  if (!open || !coords) return null;
  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-[60] cursor-default bg-transparent"
      />
      <div
        ref={popoverRef}
        className={cn(
          'animate-popover-in fixed z-[61] min-w-[220px] rounded-lg border border-border bg-popover shadow-xl shadow-black/40 overflow-hidden',
          className,
        )}
        style={{
          top: coords.top,
          left: coords.left,
          maxHeight: coords.maxHeight,
          transformOrigin: 'top left',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

export function PopoverList({ children }: { children: React.ReactNode }): JSX.Element {
  return <ul className="overflow-y-auto p-1 max-h-72 stagger-list">{children}</ul>;
}

export function PopoverRow({
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
          'tap w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left',
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
