import { forwardRef } from 'react';
import { MoreHorizontal } from 'lucide-react';

// -----------------------------------------------------------------------------
// "More projects" sidebar trigger — replaces the long scrollable list with a
// single row that opens a searchable popover. Matches Jira's "More spaces".
// -----------------------------------------------------------------------------

export const MoreProjectsTrigger = forwardRef<
  HTMLButtonElement,
  { totalCount: number; hiddenCount: number; onOpen: () => void }
>(function MoreProjectsTrigger({ totalCount, hiddenCount, onOpen }, ref): JSX.Element {
  const ariaLabel = `Show all ${totalCount} projects`;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      className="group w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span className="shrink-0 h-5 w-5 inline-flex items-center justify-center rounded-md bg-muted/40 group-hover:bg-muted/70 transition-colors">
        <MoreHorizontal className="h-3 w-3" />
      </span>
      <span className="flex-1 text-start truncate">{'More projects'}</span>
      <span className="text-[10px] text-muted-foreground/60">{hiddenCount}</span>
    </button>
  );
});
