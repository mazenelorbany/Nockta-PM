import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { QueryErrorState, Spinner, cn } from '@nockta/ui';
import { X } from 'lucide-react';

import {
  AvatarCircle, DueDateChip, PriorityDot, StatusPill,
} from '../../components/task-bits';
import { api } from '../../lib/api';

import type { ProjectGroup, WorkloadDetailResp } from './types';

// =============================================================================
// Detail modal — drills into one person's open workload. Renders summary
// stats, open-task list (clickable → TaskDetailDrawer), status breakdown,
// overdue/due-soon counts, and a 30-day completion-trend bar chart.
// =============================================================================

export function WorkloadDetailModal({
  userId,
  onClose,
  onOpenTask,
}: {
  userId: string;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}): JSX.Element {
  const detailQuery = useQuery({
    queryKey: ['workload-detail', userId],
    queryFn: () => api.get<WorkloadDetailResp>(`/analytics/workload/${userId}`),
  });

  // Esc to close — same pattern as KeyboardShortcuts overlay.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const data = detailQuery.data;
  const tasksByProject = groupTasksByProject(data?.openTasks ?? []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 px-5 py-4 border-b border-border">
          {data?.user ? (
            <>
              <AvatarCircle user={data.user} size={36} />
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold truncate">{data.user.name}</h2>
                <p className="text-xs text-muted-foreground truncate">{data.user.email}</p>
              </div>
            </>
          ) : (
            <div className="flex-1 text-sm text-muted-foreground">
              {detailQuery.isLoading ? 'Loading…' : 'Unknown user'}
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1 -m-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {detailQuery.isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Spinner />
            </div>
          ) : detailQuery.isError ? (
            <QueryErrorState
              title="Couldn't load workload detail"
              error={detailQuery.error}
              onRetry={() => void detailQuery.refetch()}
            />
          ) : data ? (
            <>
              <StatGrid data={data} />
              <StatusBreakdown data={data} />
              <CompletionTrend series={data.completionTrend} />
              <OpenTasksList
                groups={tasksByProject}
                emptyHint="No open tasks — they're either done or this person doesn't own any work in the projects you can see."
                onOpenTask={onOpenTask}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatGrid({ data }: { data: WorkloadDetailResp }): JSX.Element {
  const { summary, overdueCount, dueSoonCount } = data;
  const cells: { label: string; value: string | number; tone?: string }[] = [
    { label: 'Open', value: summary.total },
    { label: 'Points', value: summary.points },
    { label: 'Load', value: summary.loadScore },
    {
      label: 'Overdue',
      value: overdueCount,
      tone: overdueCount > 0 ? 'text-status-blocked' : undefined,
    },
    {
      label: 'Due ≤ 7d',
      value: dueSoonCount,
      tone: dueSoonCount > 0 ? 'text-priority-high' : undefined,
    },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
      {cells.map((c) => (
        <div
          key={c.label}
          className="rounded-md border border-border bg-secondary/30 px-3 py-2"
        >
          <p className="nockta-eyebrow text-[0.6rem] text-muted-foreground">{c.label}</p>
          <p className={cn('mt-0.5 text-lg font-semibold tabular-nums', c.tone)}>{c.value}</p>
        </div>
      ))}
    </div>
  );
}

function StatusBreakdown({ data }: { data: WorkloadDetailResp }): JSX.Element | null {
  if (data.byStatus.length === 0) return null;
  const total = data.byStatus.reduce((acc, s) => acc + s.count, 0) || 1;
  return (
    <section>
      <h3 className="nockta-eyebrow text-muted-foreground mb-2">By status</h3>
      <div className="flex h-2 rounded-full overflow-hidden bg-secondary/40">
        {data.byStatus.map((s) => (
          <div
            key={s.status}
            className={cn(statusBarTone(s.status))}
            style={{ width: `${(s.count / total) * 100}%` }}
            title={`${s.status}: ${s.count}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {data.byStatus.map((s) => (
          <span key={s.status} className="inline-flex items-center gap-1.5">
            <span className={cn('h-1.5 w-1.5 rounded-full', statusBarTone(s.status))} />
            <span className="text-muted-foreground">{s.status}</span>
            <span className="font-medium tabular-nums">{s.count}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

function statusBarTone(status: string): string {
  const s = status.toLowerCase();
  if (s === 'todo')         return 'bg-status-todo';
  if (s === 'in progress')  return 'bg-status-in-progress';
  if (s === 'in review')    return 'bg-status-in-review';
  if (s === 'testing')      return 'bg-status-testing';
  if (s === 'done' || s === 'approved') return 'bg-status-done';
  if (s.includes('block'))  return 'bg-status-blocked';
  return 'bg-muted-foreground/50';
}

function CompletionTrend({ series }: { series: { date: string; completed: number }[] }): JSX.Element {
  const max = Math.max(1, ...series.map((d) => d.completed));
  const totalCompleted = series.reduce((acc, d) => acc + d.completed, 0);
  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="nockta-eyebrow text-muted-foreground">Completed last 30 days</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {totalCompleted} total
        </span>
      </div>
      <div className="flex items-end gap-[2px] h-16 bg-secondary/20 rounded-md px-2 py-1.5">
        {series.map((d) => {
          const h = d.completed === 0 ? 1 : Math.max(3, (d.completed / max) * 100);
          return (
            <div
              key={d.date}
              className={cn(
                'flex-1 rounded-sm',
                d.completed === 0 ? 'bg-border/60' : 'bg-brand/70',
              )}
              style={{ height: `${h}%` }}
              title={`${d.date}: ${d.completed} completed`}
            />
          );
        })}
      </div>
    </section>
  );
}

function groupTasksByProject(tasks: WorkloadDetailResp['openTasks']): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const t of tasks) {
    const g = map.get(t.project.id) ?? { project: t.project, tasks: [] };
    g.tasks.push(t);
    map.set(t.project.id, g);
  }
  return Array.from(map.values()).sort((a, b) => b.tasks.length - a.tasks.length);
}

function OpenTasksList({
  groups,
  emptyHint,
  onOpenTask,
}: {
  groups: ProjectGroup[];
  emptyHint: string;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  if (groups.length === 0) {
    return (
      <section>
        <h3 className="nockta-eyebrow text-muted-foreground mb-2">Open tasks</h3>
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      </section>
    );
  }
  return (
    <section>
      <h3 className="nockta-eyebrow text-muted-foreground mb-2">Open tasks</h3>
      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.project.id}>
            <p className="text-[11px] font-semibold text-muted-foreground mb-1">
              {g.project.key} — {g.project.name}
              <span className="ml-1 text-muted-foreground/70 font-normal">
                ({g.tasks.length})
              </span>
            </p>
            <ul className="rounded-md border border-border overflow-hidden divide-y divide-border">
              {g.tasks.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onOpenTask(t.id)}
                    className="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-secondary/40 transition-colors"
                  >
                    <PriorityDot priority={t.priority} />
                    <span className="text-[11px] font-mono text-muted-foreground tabular-nums shrink-0">
                      {g.project.key}-{t.keyNumber}
                    </span>
                    <span className="flex-1 text-sm truncate">{t.title}</span>
                    {t.isBlocked && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-status-blocked shrink-0">
                        blocked
                      </span>
                    )}
                    <DueDateChip dueDate={t.dueDate} />
                    <StatusPill status={t.status} className="shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
