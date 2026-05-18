import { useDroppable } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@nockta/ui';
import { BacklogRow } from './BacklogRow';
import type { ContainerId, PlannerTask, Sprint } from './types';

// =============================================================================
// Section — one collapsible droppable container with its own task list.
// =============================================================================

export function Section({
  id,
  droppableId,
  title,
  icon,
  state,
  dates,
  tasks,
  totalCount,
  isDragHighlight,
  actions,
  afterBody,
  selected,
  onToggleSelect,
  onOpenTask,
  emptyMessage,
  velocityBaseline,
}: {
  id: string;
  droppableId: ContainerId;
  title: string;
  icon: React.ReactNode;
  state?: Sprint['state'];
  dates?: [string | null, string | null];
  tasks: PlannerTask[];
  totalCount: number;
  isDragHighlight?: boolean;
  actions?: React.ReactNode;
  /** Extra content rendered below the task list when the section is open. Used
   *  for per-sprint extras like the AI summary on active/completed sprints. */
  afterBody?: React.ReactNode;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpenTask: (id: string) => void;
  emptyMessage: string;
  /** Historical velocity (average completed estimate per sprint) for the
   *  project. When set we render a points/baseline ratio chip and a yellow
   *  warning if this sprint's planned points exceed 110% of the baseline. */
  velocityBaseline?: number | null;
}): JSX.Element {
  // Backlog and active sprints start expanded; planned and completed sprints
  // start collapsed so the page is compact by default.
  const persistKey = `nockta:backlog:section:${droppableId}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(persistKey);
      if (raw !== null) return raw === '1';
    } catch { /* ignore */ }
    return droppableId === 'backlog' || state === 'active';
  });
  useEffect(() => {
    try { localStorage.setItem(persistKey, open ? '1' : '0'); } catch { /* ignore */ }
  }, [open, persistKey]);

  const { setNodeRef, isOver } = useDroppable({ id });

  // Compute totals for the header chip.
  const points = tasks.reduce((acc, t) => acc + (t.estimate ?? 0), 0);
  const startDate = dates?.[0] ? new Date(dates[0]) : null;
  const endDate = dates?.[1] ? new Date(dates[1]) : null;

  return (
    <section
      ref={setNodeRef}
      className={cn(
        'rounded-xl border bg-card/40 transition-colors',
        (isDragHighlight || isOver) ? 'border-primary/50 bg-primary/5' : 'border-border'
      )}
    >
      <header
        className="flex items-center gap-3 px-4 py-2.5 cursor-pointer select-none"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        {icon}
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {state && <SprintStatePill state={state} />}
        <span className="rounded-md bg-secondary/60 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {tasks.length === totalCount ? totalCount : `${tasks.length} / ${totalCount}`}
        </span>
        {points > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" /> {points} pts
          </span>
        )}
        {/* Capacity indicator — only meaningful on sprints (not the backlog),
            and only when the project has enough completed-sprint history to
            anchor a baseline. Renders the ratio AND a yellow warning when
            the planned scope crosses 110% of historical velocity. */}
        {state && state !== 'completed' && (velocityBaseline ?? 0) > 0 && (
          <CapacityChip points={points} baseline={velocityBaseline ?? 0} />
        )}
        {(startDate || endDate) && (
          <span className="text-[10px] text-muted-foreground">
            {startDate?.toLocaleDateString() ?? '—'} → {endDate?.toLocaleDateString() ?? '—'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      </header>
      {open && (
        <>
          <div className="border-t border-border px-2 py-2 space-y-1">
            {tasks.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground py-6 px-4">{emptyMessage}</p>
            ) : (
              tasks.map((t) => (
                <BacklogRow
                  key={t.id}
                  task={t}
                  from={droppableId}
                  isSelected={selected.has(t.id)}
                  onToggleSelect={() => onToggleSelect(t.id)}
                  onOpen={() => onOpenTask(t.id)}
                />
              ))
            )}
          </div>
          {afterBody && (
            <div className="border-t border-border/60 px-3 py-2">{afterBody}</div>
          )}
        </>
      )}
    </section>
  );
}

// =============================================================================
// SprintStatePill — small colored chip for the section header.
// =============================================================================

export function SprintStatePill({ state }: { state: Sprint['state'] }): JSX.Element {
  const map: Record<Sprint['state'], string> = {
    planned: 'bg-muted text-muted-foreground',
    active: 'bg-primary/15 text-primary',
    completed: 'bg-status-done/15 text-status-done',
  };
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-medium', map[state])}>
      {state}
    </span>
  );
}

// =============================================================================
// CapacityChip — per-sprint scope-vs-baseline indicator. Renders neutrally
// when scope fits, and switches to a yellow warning when scope exceeds 110%
// of historical velocity. Wider thresholds were considered (e.g. tone bands
// at 80/100/120%) but a single boundary keeps the visual noise low for the
// common-case "fits comfortably" sprint.
// =============================================================================

export function CapacityChip({ points, baseline }: { points: number; baseline: number }): JSX.Element {
  const ratio = baseline > 0 ? points / baseline : 0;
  const overcap = ratio > 1.1;
  return (
    <span
      title={`Planned ${points} pts · historical velocity ≈ ${Math.round(baseline)} pts`}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        overcap
          ? 'bg-priority-high/15 text-priority-high'
          : 'bg-secondary/60 text-muted-foreground',
      )}
    >
      <span aria-hidden="true">{overcap ? '!' : '·'}</span>
      <span className="tabular-nums">{Math.round(ratio * 100)}%</span>
      <span>capacity</span>
    </span>
  );
}
