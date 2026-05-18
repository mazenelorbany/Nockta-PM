import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

// -----------------------------------------------------------------------------
// Section
// -----------------------------------------------------------------------------

export function Section({
  title,
  count,
  action,
  children,
  storageKey,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
  /** localStorage key for persisting open/closed state. Defaults to title. */
  storageKey?: string;
}): JSX.Element {
  const key = `nockta:sidebar:section:${storageKey ?? title.toLowerCase()}`;
  // Top-level sidebar sections (Personal / Projects / System) default to open;
  // a stored '0' means the user explicitly collapsed it.
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== '0';
    } catch {
      return true;
    }
  });
  function toggle(): void {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(key, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }
  return (
    <div>
      <div className="flex items-center justify-between px-1 mb-1 group/section">
        <button
          type="button"
          onClick={toggle}
          className="flex flex-1 items-center gap-1 px-1 py-0.5 rounded text-start hover:bg-accent/30 transition-colors"
          aria-expanded={open}
        >
          <ChevronRight
            className="h-2.5 w-2.5 text-muted-foreground/50 shrink-0 transition-transform duration-200 ease-out"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
          <span className="nockta-eyebrow text-muted-foreground/70 flex items-center gap-1.5">
            {title}
            {count !== undefined && (
              <span className="text-[10px] text-muted-foreground/50 font-medium">{count}</span>
            )}
          </span>
        </button>
        {action}
      </div>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}
