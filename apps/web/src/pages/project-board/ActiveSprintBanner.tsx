import type { TaskFilters } from '../../components/board-toolbar';

import type { ActiveSprint } from './types';

/**
 * The "Active sprint" banner that sits between the project header and the
 * BoardToolbar when a sprint is active. Shows the sprint name + date range,
 * its optional goal, and a button that toggles a sprint-only filter.
 */
export function ActiveSprintBanner({
  sprint,
  filters,
  onFiltersChange,
}: {
  sprint: ActiveSprint;
  filters: TaskFilters;
  onFiltersChange: (next: TaskFilters) => void;
}): JSX.Element {
  return (
    <div className="px-4 sm:px-6 md:px-8 py-2 border-b border-border bg-brand/10 flex flex-col gap-1">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 nockta-eyebrow text-brand">
            <span className="h-2 w-2 rounded-full bg-brand animate-pulse" />
            Active sprint
          </span>
          <span className="text-sm font-semibold">{sprint.name}</span>
          {(sprint.startDate || sprint.endDate) && (
            <span className="text-xs text-muted-foreground">
              {sprint.startDate
                ? new Date(sprint.startDate).toLocaleDateString()
                : '—'}
              {' → '}
              {sprint.endDate
                ? new Date(sprint.endDate).toLocaleDateString()
                : '—'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {filters.sprintId === sprint.id ? (
            <button
              type="button"
              onClick={() => {
                const { sprintId: _drop, ...rest } = filters;
                onFiltersChange(rest);
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Show all tasks
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onFiltersChange({ ...filters, sprintId: sprint.id })}
              className="tap rounded-md bg-brand px-3 py-1 text-xs font-medium text-brand-foreground hover:opacity-90 transition-[opacity,transform] duration-150"
            >
              Sprint board →
            </button>
          )}
        </div>
      </div>
      {sprint.goal && (
        <p
          className="text-xs text-foreground/80 italic truncate"
          title={sprint.goal}
        >
          &ldquo;{sprint.goal}&rdquo;
        </p>
      )}
    </div>
  );
}
