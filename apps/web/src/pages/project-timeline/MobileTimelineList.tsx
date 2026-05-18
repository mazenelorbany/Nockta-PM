import {
  AvatarCircle,
  BlockedBadge,
  PriorityDot,
  StatusPill,
  TypeBadge,
} from '../../components/task-bits';

import type { Task } from './types';

// =============================================================================
// MobileTimelineList — drop-in for <md viewports. Gantt math doesn't survive
// a 375px wide screen, so we surface the same task set as a vertical list
// sorted by start date. Tap a row to open the task drawer; date editing
// still happens in the drawer where the calendar pickers fit.
// =============================================================================
export function MobileTimelineList({
  tasks,
  onOpenTask,
}: {
  tasks: Task[];
  onOpenTask: (id: string) => void;
}): JSX.Element {
  const scheduled = tasks.filter((t) => t.startDate && t.dueDate);
  const unscheduled = tasks.filter((t) => !t.startDate || !t.dueDate);
  // Sort scheduled ascending by startDate so the earliest comes first.
  const sortedScheduled = [...scheduled].sort((a, b) => {
    const aT = a.startDate ? new Date(a.startDate).getTime() : 0;
    const bT = b.startDate ? new Date(b.startDate).getTime() : 0;
    return aT - bT;
  });

  function fmt(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  if (sortedScheduled.length === 0 && unscheduled.length === 0) {
    return (
      <div className="flex-1 overflow-auto p-4">
        <p className="text-sm text-muted-foreground text-center py-12">
          No tasks match your filters.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-3 space-y-4">
      {sortedScheduled.length > 0 && (
        <section>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 px-1">
            Scheduled ({sortedScheduled.length})
          </p>
          <ul className="space-y-2">
            {sortedScheduled.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onOpenTask(t.id)}
                  className="tap w-full text-left rounded-lg border border-border bg-card p-3 hover:border-ring transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1.5 min-w-0">
                    {t.type && <TypeBadge type={t.type} />}
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                      {t.key}
                    </span>
                    <PriorityDot priority={t.priority} />
                    <BlockedBadge blocked={t.isBlocked} />
                  </div>
                  <div className="text-sm font-medium leading-snug mb-2 line-clamp-2">
                    {t.title}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-[11px]">
                    <StatusPill status={t.status} />
                    <span className="inline-flex items-center gap-1 rounded bg-secondary/60 px-1.5 py-0.5 text-muted-foreground tabular-nums">
                      {fmt(t.startDate)} → {fmt(t.dueDate)}
                    </span>
                    {t.assignee && (
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground ml-auto">
                        <AvatarCircle user={t.assignee} size={16} />
                        <span className="truncate max-w-[120px]">{t.assignee.name}</span>
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unscheduled.length > 0 && (
        <section>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 px-1">
            Needs scheduling ({unscheduled.length})
          </p>
          <ul className="space-y-2">
            {unscheduled.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onOpenTask(t.id)}
                  className="tap w-full text-left rounded-lg border border-dashed border-border bg-card/40 p-3 hover:border-ring transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1.5 min-w-0">
                    {t.type && <TypeBadge type={t.type} />}
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                      {t.key}
                    </span>
                    <PriorityDot priority={t.priority} />
                    <BlockedBadge blocked={t.isBlocked} />
                  </div>
                  <div className="text-sm font-medium leading-snug mb-2 line-clamp-2">
                    {t.title}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-[11px]">
                    <StatusPill status={t.status} />
                    <span className="text-muted-foreground/70">
                      {t.startDate ? `Start ${fmt(t.startDate)}` : 'No start'}
                      {' · '}
                      {t.dueDate ? `Due ${fmt(t.dueDate)}` : 'No due'}
                    </span>
                    {t.assignee && (
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground ml-auto">
                        <AvatarCircle user={t.assignee} size={16} />
                        <span className="truncate max-w-[120px]">{t.assignee.name}</span>
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
