import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  cn, EmptyState, NocktaMark, QueryErrorState, SkeletonList, Spinner,
} from '@nockta/ui';
import { Users as UsersIcon, X } from 'lucide-react';
import {
  AvatarCircle, DueDateChip, PriorityDot, StatusPill, type Priority,
} from '../components/task-bits';
import { TaskDetailDrawer } from '../components/TaskDetailDrawer';
import { api } from '../lib/api';

// =============================================================================
// /workload — cross-project capacity view. Each row is one person with an
// open-task count, a stacked priority bar, and a "load score" that weights
// Critical 4x / High 3x / Medium 2x / Low 1x. Filterable by project + team.
// =============================================================================

interface WorkloadRow {
  userId: string;
  total: number;
  points: number;
  byPriority: { Critical: number; High: number; Medium: number; Low: number };
  loadScore: number;
  user: { id: string; name: string; email: string; avatarUrl: string | null } | null;
  /** Open-task count snapshot for each of the last 7 days (oldest → newest). */
  series?: number[];
}

interface WorkloadResp {
  rows: WorkloadRow[];
}

interface ProjectLite { id: string; key: string; name: string }
interface TeamLite { id: string; name: string; slug: string }

export function WorkloadPage(): JSX.Element {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState('');
  const [teamId, setTeamId] = useState('');
  // Detail modal — which person's drill-down is open. Null = closed.
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  // When the user clicks a task inside the detail modal, we route into the
  // standard TaskDetailDrawer by setting ?task=ID. Same pattern every other
  // page in the app uses to host the drawer.
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get('task');
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
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectLite[]>('/projects'),
  });
  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<TeamLite[]>('/teams'),
  });
  const qs = new URLSearchParams();
  if (projectId) qs.set('projectId', projectId);
  if (teamId) qs.set('teamId', teamId);
  const workloadQuery = useQuery({
    queryKey: ['workload', qs.toString()],
    queryFn: () => api.get<WorkloadResp>(`/analytics/workload?${qs.toString()}`),
  });

  const rows = workloadQuery.data?.rows ?? [];
  // Use the max load score as the scale; protect against zero.
  const maxLoad = Math.max(1, ...rows.map((r) => r.loadScore));

  return (
    <div className="flex flex-col h-full">
      <header className="relative overflow-hidden border-b border-border gradient-mesh-subtle">
        <div
          className="absolute -right-12 -bottom-16 text-brand/[0.05] pointer-events-none select-none"
          aria-hidden="true"
        >
          <NocktaMark className="h-[240px] w-[240px]" />
        </div>
        <div className="relative px-4 sm:px-6 md:px-8 pt-6 sm:pt-8 pb-6 sm:pb-8">
          <span className="nockta-eyebrow text-brand">{t('nav.workspace', 'Workspace')}</span>
          <h1
            className="display-heading mt-2 leading-[1.04]"
            style={{ fontSize: 'clamp(1.8rem, 3.4vw, 2.6rem)' }}
          >
            {t('nav.workload', 'Workload')}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {t(
              'workload.subtitle',
              "Who's loaded with what. Priority-weighted scoring across every open task — Critical counts as 4×, High 3×, Medium 2×, Low 1×.",
            )}
          </p>
        </div>
      </header>

      <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <Pill
          label={t('notifications_bell.filter_project', 'Project')}
          value={projectId}
          onChange={setProjectId}
          options={[
            { value: '', label: t('inbox.all_projects', 'All projects') },
            ...(projectsQuery.data ?? []).map((p) => ({ value: p.id, label: `${p.key} — ${p.name}` })),
          ]}
        />
        <Pill
          label={t('workload.team', 'Team')}
          value={teamId}
          onChange={setTeamId}
          options={[
            { value: '', label: t('workload.everyone', 'Everyone') },
            ...(teamsQuery.data ?? []).map((teamItem) => ({ value: teamItem.id, label: teamItem.name })),
          ]}
        />
        {(projectId || teamId) && (
          <button
            type="button"
            onClick={() => {
              setProjectId('');
              setTeamId('');
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
        <span className="nockta-eyebrow text-muted-foreground ml-auto">
          {rows.length} {rows.length === 1 ? 'person' : 'people'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 md:px-8 py-4 sm:py-6">
        {workloadQuery.isLoading ? (
          <SkeletonList rows={6} rowClassName="h-16" />
        ) : workloadQuery.isError ? (
          <QueryErrorState
            title="Couldn't load workload"
            error={workloadQuery.error}
            onRetry={() => void workloadQuery.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<UsersIcon className="h-5 w-5" />}
            title="No open work in this view"
            description="Either nobody on this team has an open task right now, or the filters are too tight. Clear them to see the full org."
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <WorkloadRowItem
                key={r.userId}
                row={r}
                maxLoad={maxLoad}
                onOpen={() => setDetailUserId(r.userId)}
              />
            ))}
          </ul>
        )}
      </div>

      {detailUserId && (
        <WorkloadDetailModal
          userId={detailUserId}
          onClose={() => setDetailUserId(null)}
          onOpenTask={(id) => {
            // Keep the modal mounted behind the drawer so the user lands back
            // on the same person when they close the task.
            openTask(id);
          }}
        />
      )}
      {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />}
    </div>
  );
}

function WorkloadRowItem({
  row,
  maxLoad,
  onOpen,
}: {
  row: WorkloadRow;
  maxLoad: number;
  onOpen: () => void;
}): JSX.Element {
  const widthPct = (row.loadScore / maxLoad) * 100;
  // Stacked bar — split widthPct across priorities proportional to their counts.
  const total = row.total || 1;
  const segments: { key: keyof WorkloadRow['byPriority']; color: string }[] = [
    { key: 'Critical', color: 'bg-priority-critical' },
    { key: 'High', color: 'bg-priority-high' },
    { key: 'Medium', color: 'bg-priority-medium' },
    { key: 'Low', color: 'bg-priority-low' },
  ];

  return (
    <li
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="grid grid-cols-[200px_1fr_220px] gap-4 items-center rounded-lg border border-border bg-card/40 px-4 py-3 cursor-pointer hover:bg-card/70 hover:border-brand/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 transition-colors"
    >
      <div className="flex items-center gap-2 min-w-0">
        {row.user ? (
          <>
            <AvatarCircle user={row.user} size={26} />
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{row.user.name}</p>
              <p className="text-[10px] text-muted-foreground truncate">{row.user.email}</p>
            </div>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">Unknown</span>
        )}
      </div>

      <div>
        <div className="h-3 rounded-full bg-secondary/50 overflow-hidden flex">
          {segments.map((s) => {
            const count = row.byPriority[s.key];
            if (count === 0) return null;
            const pct = (count / total) * widthPct;
            return (
              <div
                key={s.key}
                className={cn(s.color)}
                style={{ width: `${pct}%` }}
                title={`${s.key}: ${count}`}
              />
            );
          })}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          {segments.map((s) => row.byPriority[s.key] > 0 && (
            <span key={s.key} className="inline-flex items-center gap-1">
              <span className={cn('h-1.5 w-1.5 rounded-full', s.color)} />
              {s.key} {row.byPriority[s.key]}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        <Sparkline series={row.series ?? [row.total]} />
        <div className="text-right text-xs">
          <p className="font-semibold tabular-nums">{row.total} open</p>
          <p className="text-muted-foreground tabular-nums">{row.points} pts · load {row.loadScore}</p>
        </div>
      </div>
    </li>
  );
}

/**
 * Inline SVG sparkline of the last-7-days open-task series. Width ~80px,
 * height ~20px. Brand-coloured stroke, no chart library — just a polyline
 * over the N points (with min/max normalised to the bounding box).
 */
function Sparkline({ series }: { series: number[] }): JSX.Element {
  const W = 80;
  const H = 20;
  const PAD = 1;
  const pts = series.length > 0 ? series : [0];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const stepX = pts.length > 1 ? (W - PAD * 2) / (pts.length - 1) : 0;
  const coords = pts.map((v, i) => {
    const x = PAD + i * stepX;
    // Invert Y so larger values sit at the top.
    const y = PAD + (H - PAD * 2) * (1 - (v - min) / range);
    return [x, y] as const;
  });
  // If every value is the same, draw a flat horizontal mid-line so the row
  // still feels alive (the path would otherwise be at y=PAD because of the
  // 1-(v-min)/range collapse).
  const flat = min === max;
  const path = coords
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${flat ? (H / 2).toFixed(1) : y.toFixed(1)}`)
    .join(' ');
  const last = coords[coords.length - 1];
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="text-brand shrink-0"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {last && (
        <circle
          cx={last[0]}
          cy={flat ? H / 2 : last[1]}
          r={1.6}
          fill="currentColor"
        />
      )}
    </svg>
  );
}

// =============================================================================
// Detail modal — drills into one person's open workload. Renders summary
// stats, open-task list (clickable → TaskDetailDrawer), status breakdown,
// overdue/due-soon counts, and a 30-day completion-trend bar chart.
// =============================================================================

interface WorkloadDetailResp {
  user: { id: string; name: string; email: string; avatarUrl: string | null } | null;
  summary: {
    total: number;
    points: number;
    loadScore: number;
    byPriority: { Critical: number; High: number; Medium: number; Low: number };
  };
  byStatus: { status: string; count: number }[];
  overdueCount: number;
  dueSoonCount: number;
  openTasks: {
    id: string;
    keyNumber: number;
    title: string;
    status: string;
    priority: Priority;
    isBlocked: boolean;
    dueDate: string | null;
    estimate: number | null;
    project: { id: string; key: string; name: string };
  }[];
  completionTrend: { date: string; completed: number }[];
}

function WorkloadDetailModal({
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
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
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

interface ProjectGroup {
  project: { id: string; key: string; name: string };
  tasks: WorkloadDetailResp['openTasks'];
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

function Pill({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  const isActive = value !== '';
  const current = options.find((o) => o.value === value);
  return (
    <label
      className={cn(
        'relative inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer transition-colors',
        isActive
          ? 'border-brand/40 bg-accent text-foreground'
          : 'border-border bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="nockta-eyebrow text-[0.6rem] opacity-60">{label}</span>
      {isActive && <span className="truncate max-w-[140px]">{current?.label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
