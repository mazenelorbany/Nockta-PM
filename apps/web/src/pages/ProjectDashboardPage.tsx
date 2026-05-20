import { useQuery } from '@tanstack/react-query';
import { Clock, ListChecks, ShieldAlert, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { cn } from '@nockta/ui';

import { ProjectTabs } from '../components/ProjectTabs';
import { TaskDetailDrawer } from '../components/TaskDetailDrawer';
import {
  AvatarCircle,
  BlockedBadge,
  DueDateChip,
  PriorityDot,
  StatusPill,
  TypeBadge,
  type Priority,
  type TaskType,
} from '../components/task-bits';
import { api } from '../lib/api';
import { useResolvedProject } from '../lib/project-route';
import { queryKeys } from '../lib/query-keys';

// =============================================================================
// /projects/:projectId/dashboard
//
// Project-level summary that answers two questions Managers ask every day:
//
//   1. Where is each teammate's attention? — A grid of teammate cards with
//      task counts + time logged this week + total time on this project.
//      Sorted by open-task count descending so the busiest person is first.
//   2. What's still open right now? — A flat list of every non-done task in
//      the project including subtasks, so subtasks don't disappear when a
//      Manager is looking for "everything in flight".
//
// Both come from data we already had — analytics.teamStats + the existing
// /tasks/project/:projectId endpoint. The page does the join client-side.
// =============================================================================

interface Project {
  id: string;
  key: string;
  name: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
}

interface TeamStatRow {
  userId: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    kind: 'internal' | 'client';
  } | null;
  taskCount: number;
  openCount: number;
  doneCount: number;
  inProgressCount: number;
  blockedCount: number;
  overdueCount: number;
  criticalOpen: number;
  highOpen: number;
  timeLoggedSeconds: number;
  timeThisWeekSeconds: number;
}

interface Task {
  id: string;
  key: string;
  title: string;
  type?: TaskType;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  dueDate?: string | null;
  parentTaskId?: string | null;
  assignee?: { id: string; name: string; avatarUrl?: string | null } | null;
}

export function ProjectDashboardPage(): JSX.Element {
  const { projectId } = useResolvedProject();
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get('task');
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);

  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const statsQuery = useQuery({
    queryKey: ['project', projectId, 'team-stats'],
    queryFn: () => api.get<TeamStatRow[]>(`/analytics/projects/${projectId}/team-stats`),
    enabled: Boolean(projectId),
  });
  const tasksQuery = useQuery({
    queryKey: queryKeys.projectTasks(projectId),
    queryFn: () => api.get<Task[]>(`/tasks/project/${projectId}`),
    enabled: Boolean(projectId),
  });

  const project = projectQuery.data;
  const stats = useMemo(() => statsQuery.data ?? [], [statsQuery.data]);
  const allTasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);

  // Open tasks = anything not Done/Approved. Subtasks are intentionally
  // INCLUDED here — the dashboard's job is to surface every loose end, not
  // hide subtasks under their parents the way the board does.
  const openTasks = useMemo(
    () => allTasks.filter((t) => !/done|approved/i.test(t.status)),
    [allTasks],
  );
  const filteredOpen = useMemo(() => {
    if (!assigneeFilter) return openTasks;
    if (assigneeFilter === '__unassigned__') return openTasks.filter((t) => !t.assignee);
    return openTasks.filter((t) => t.assignee?.id === assigneeFilter);
  }, [openTasks, assigneeFilter]);

  // Workspace-wide totals for the top stat row.
  const totals = useMemo(() => {
    let open = 0;
    let blocked = 0;
    let overdue = 0;
    let timeWeek = 0;
    for (const r of stats) {
      open += r.openCount;
      blocked += r.blockedCount;
      overdue += r.overdueCount;
      timeWeek += r.timeThisWeekSeconds;
    }
    return { open, blocked, overdue, timeWeek };
  }, [stats]);

  function openTask(id: string): void {
    setSearchParams((sp) => {
      sp.set('task', id);
      return sp;
    });
  }
  function closeTask(): void {
    setSearchParams((sp) => {
      sp.delete('task');
      return sp;
    });
  }

  if (!project) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-3 sm:py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">
            {project.key}
          </span>
          <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate">{project.name}</h1>
          <span className="text-muted-foreground/60 hidden sm:inline">·</span>
          <span className="text-sm text-muted-foreground hidden sm:inline">Dashboard</span>
        </div>
      </header>

      <ProjectTabs projectId={projectId} />

      <div className="flex-1 overflow-auto p-4 sm:p-6 md:p-8 space-y-6 sm:space-y-8">
        {/* Top stat strip — quick health snapshot. Total time-this-week sums
            across everyone so the Manager sees the team's collective focus. */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile label="Open" value={totals.open} icon={<ListChecks className="h-4 w-4" />} />
          <StatTile
            label="Blocked"
            value={totals.blocked}
            tone={totals.blocked > 0 ? 'danger' : undefined}
            icon={<ShieldAlert className="h-4 w-4" />}
          />
          <StatTile
            label="Overdue"
            value={totals.overdue}
            tone={totals.overdue > 0 ? 'danger' : undefined}
          />
          <StatTile
            label="Logged this week"
            value={formatHours(totals.timeWeek)}
            icon={<Clock className="h-4 w-4" />}
          />
        </section>

        {/* Team board — one card per teammate */}
        <section>
          <header className="flex items-baseline justify-between mb-3">
            <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              Team
            </h2>
            <span className="nockta-eyebrow text-muted-foreground">
              {stats.filter((s) => s.userId).length}{' '}
              {stats.filter((s) => s.userId).length === 1 ? 'person' : 'people'}
            </span>
          </header>
          {statsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : stats.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card/30 p-6 text-center text-sm text-muted-foreground">
              No one's been assigned to a task on this project yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {stats.map((row) => (
                <TeammateCard
                  key={row.userId ?? 'unassigned'}
                  row={row}
                  active={assigneeFilter === (row.userId ?? '__unassigned__')}
                  onClick={() => {
                    const key = row.userId ?? '__unassigned__';
                    setAssigneeFilter((prev) => (prev === key ? null : key));
                  }}
                />
              ))}
            </div>
          )}
        </section>

        {/* Open tasks (incl. subtasks) */}
        <section>
          <header className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-muted-foreground" />
              Open work
              <span className="nockta-eyebrow text-muted-foreground ml-1">
                {filteredOpen.length}
                {assigneeFilter && ` of ${openTasks.length}`}
              </span>
            </h2>
            {assigneeFilter && (
              <button
                type="button"
                onClick={() => setAssigneeFilter(null)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear filter
              </button>
            )}
          </header>
          {filteredOpen.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card/30 p-6 text-center text-sm text-muted-foreground">
              {assigneeFilter
                ? 'No open tasks for this person right now.'
                : 'Nothing open. Either everything is shipped or there is nothing to do.'}
            </div>
          ) : (
            <ul className="rounded-lg border border-border overflow-hidden divide-y divide-border bg-card/40">
              {filteredOpen.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => openTask(t.id)}
                    className="w-full grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 items-center px-3 py-2 text-sm text-left hover:bg-accent/30 transition-colors"
                  >
                    <span className="flex items-center gap-1.5 shrink-0">
                      {t.type && <TypeBadge type={t.type} />}
                      <span className="text-[10px] font-mono text-muted-foreground">{t.key}</span>
                    </span>
                    <span className="flex items-center gap-2 min-w-0">
                      {t.parentTaskId && (
                        <span
                          className="text-[10px] text-muted-foreground/60 font-mono"
                          title="Subtask"
                        >
                          ↳
                        </span>
                      )}
                      <span className="truncate">{t.title}</span>
                      <BlockedBadge blocked={t.isBlocked} />
                    </span>
                    <PriorityDot priority={t.priority} />
                    <StatusPill status={t.status} />
                    <span className="flex items-center gap-2 shrink-0">
                      {t.dueDate && <DueDateChip dueDate={t.dueDate} done={false} />}
                      {t.assignee ? (
                        <AvatarCircle user={t.assignee} size={20} />
                      ) : (
                        <AvatarCircle user={null} size={20} />
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-muted-foreground text-right">
            <Link
              to={`/projects/${projectId}/board`}
              className="hover:text-foreground hover:underline"
            >
              Open the full board →
            </Link>
          </p>
        </section>
      </div>

      {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />}
    </div>
  );
}

// =============================================================================

function StatTile({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number | string;
  icon?: React.ReactNode | undefined;
  tone?: 'danger' | undefined;
}): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-lg border p-4 bg-card/40',
        tone === 'danger' ? 'border-status-blocked/40' : 'border-border',
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          'mt-1 text-2xl sm:text-3xl font-semibold tabular-nums',
          tone === 'danger' && 'text-status-blocked',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function TeammateCard({
  row,
  active,
  onClick,
}: {
  row: TeamStatRow;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  const isUnassigned = row.userId === null;
  const displayName = isUnassigned ? 'Unassigned' : row.user?.name ?? row.user?.email ?? 'Unknown';
  const hoursWeek = (row.timeThisWeekSeconds / 3600).toFixed(1);
  const hoursTotal = (row.timeLoggedSeconds / 3600).toFixed(0);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border bg-card text-left p-4 transition-colors hover:border-ring',
        active ? 'border-brand bg-brand/5 ring-1 ring-brand/30' : 'border-border',
      )}
      aria-pressed={active}
      title={isUnassigned ? 'Click to filter to unassigned work' : `Click to filter to ${displayName}`}
    >
      <div className="flex items-center gap-2.5 mb-3">
        {isUnassigned ? (
          <AvatarCircle user={null} size={32} />
        ) : (
          <AvatarCircle user={row.user} size={32} />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate flex items-center gap-1.5">
            {displayName}
            {row.user?.kind === 'client' && (
              <span className="text-[9px] uppercase tracking-wider px-1 py-px rounded bg-priority-medium/15 text-priority-medium font-semibold">
                External
              </span>
            )}
          </div>
          {row.user?.email && !isUnassigned && (
            <div className="text-[10px] text-muted-foreground truncate">{row.user.email}</div>
          )}
        </div>
      </div>

      {/* Task buckets — small grid so the most-actionable counts are scannable */}
      <div className="grid grid-cols-3 gap-1.5 mb-3">
        <Bucket label="Open" value={row.openCount} />
        <Bucket
          label="Blocked"
          value={row.blockedCount}
          tone={row.blockedCount > 0 ? 'danger' : undefined}
        />
        <Bucket
          label="Overdue"
          value={row.overdueCount}
          tone={row.overdueCount > 0 ? 'danger' : undefined}
        />
      </div>

      {/* Priority breakdown row — surfaced so a Manager spots someone
          loaded up with Critical/High tickets at a glance. */}
      {(row.criticalOpen > 0 || row.highOpen > 0) && (
        <div className="flex items-center gap-3 mb-3 text-[10px] text-muted-foreground">
          {row.criticalOpen > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-priority-critical" />
              {row.criticalOpen} Critical
            </span>
          )}
          {row.highOpen > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-priority-high" />
              {row.highOpen} High
            </span>
          )}
        </div>
      )}

      {/* Time logged. Hidden for the Unassigned pseudo-row since time can't
          be logged against a null user. */}
      {!isUnassigned && (
        <div className="border-t border-border/60 pt-3 flex items-baseline justify-between">
          <div>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">This week</div>
            <div className="text-base font-semibold tabular-nums">
              {hoursWeek}<span className="text-xs text-muted-foreground">h</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Total</div>
            <div className="text-sm tabular-nums text-muted-foreground">
              {hoursTotal}<span className="text-xs">h</span>
            </div>
          </div>
        </div>
      )}
    </button>
  );
}

function Bucket({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'danger' | undefined;
}): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-md border px-2 py-1.5 text-center',
        tone === 'danger'
          ? 'border-status-blocked/40 bg-status-blocked/5'
          : 'border-border/60 bg-background/40',
      )}
    >
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          'text-base font-semibold tabular-nums',
          tone === 'danger' && 'text-status-blocked',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  if (hours < 1) {
    const minutes = Math.round(seconds / 60);
    return `${minutes}m`;
  }
  return `${hours.toFixed(1)}h`;
}
