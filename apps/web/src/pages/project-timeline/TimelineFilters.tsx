import { Search } from 'lucide-react';
import { cn } from '@nockta/ui';

import type { ZoomMode } from './types';

// Filter strip: search + hide-done + show-deps + zoom switcher + counts.
// Pure presentational — all state lives on the parent.
export function TimelineFilters({
  search,
  setSearch,
  hideDone,
  setHideDone,
  showDeps,
  setShowDeps,
  zoom,
  setZoom,
  scheduledCount,
  unscheduledCount,
}: {
  search: string;
  setSearch: (v: string) => void;
  hideDone: boolean;
  setHideDone: (v: boolean) => void;
  showDeps: boolean;
  setShowDeps: (v: boolean) => void;
  zoom: ZoomMode;
  setZoom: (v: ZoomMode) => void;
  scheduledCount: number;
  unscheduledCount: number;
}): JSX.Element {
  return (
    <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-2 flex-wrap">
      <label className="relative">
        <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tasks…"
          className="h-7 w-full sm:w-64 rounded-md bg-secondary/60 pl-7 pr-2 text-xs"
        />
      </label>
      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={hideDone}
          onChange={(e) => setHideDone(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        Hide done
      </label>

      {/* Show-dependencies toggle. Default ON; persisted in localStorage as
          `nockta.timeline.deps`. */}
      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={showDeps}
          onChange={(e) => setShowDeps(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        Show dependencies
      </label>

      {/* Day / Week / Month zoom switcher. Persisted as `nockta.timeline.zoom`. */}
      <div className="inline-flex items-center rounded-md border border-border bg-secondary/40 p-0.5 text-xs">
        {(['day', 'week', 'month'] as const).map((z) => (
          <button
            key={z}
            type="button"
            onClick={() => setZoom(z)}
            className={cn(
              'px-2 py-0.5 rounded text-[11px] capitalize transition-colors',
              zoom === z
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={zoom === z}
          >
            {z}
          </button>
        ))}
      </div>

      <span className="ml-auto nockta-eyebrow text-muted-foreground">
        {scheduledCount} scheduled · {unscheduledCount} unscheduled
      </span>
    </div>
  );
}
