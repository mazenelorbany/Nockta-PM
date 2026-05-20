import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, LayoutGrid, List as ListIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn, EmptyState, NocktaMark, QueryErrorState, SkeletonList } from '@nockta/ui';

import { TaskDetailDrawer } from '../components/TaskDetailDrawer';
import {
  BlockedBadge, DueDateChip, PriorityDot, StatusPill, TypeBadge,
  type Priority, type TaskType,
} from '../components/task-bits';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import { queryKeys } from '../lib/query-keys';

// =============================================================================
// /my-tasks — cross-project task board. Backed by /search/tasks since it's the
// only endpoint that returns tasks from across projects with full filters.
// =============================================================================

type View = 'board' | 'list';

type Bucket = 'today' | 'overdue' | 'upcoming' | 'no-date' | 'done';

const BUCKET_LABELS: Record<Bucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  'no-date': 'No date',
  done: 'Done',
};

const BUCKET_ORDER: Bucket[] = ['overdue', 'today', 'upcoming', 'no-date', 'done'];

interface Task {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  dueDate: string | null;
  project?: { id: string; key: string; name: string };
  assignee?: { id: string; name: string } | null;
}

interface SearchResp {
  items: Task[];
  nextCursor: string | null;
}

interface Project {
  id: string;
  key: string;
  name: string;
}


export function MyTasksPage(): JSX.Element {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get('task');
  const [view, setView] = useState<View>('board');

  const [scope, setScope] = useState<'assigned' | 'reported' | 'watching'>('assigned');
  const [projectId, setProjectId] = useState<string>('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [hideDone, setHideDone] = useState(true);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<Project[]>('/projects'),
  });

  const tasksQuery = useQuery({
    queryKey: ['my-tasks', user?.id, scope, projectId, priority],
    queryFn: () => {
      const qs = new URLSearchParams({ limit: '200' });
      if (scope === 'assigned' && user?.id) qs.set('assigneeUserId', user.id);
      if (scope === 'reported' && user?.id) qs.set('reportedByClient', 'false'); // placeholder; reporter filter would need API support
      if (projectId) qs.set('projectId', projectId);
      if (priority) qs.set('priority', priority);
      return api.get<SearchResp>(`/search/tasks?${qs.toString()}`);
    },
    enabled: Boolean(user?.id),
  });

  const rawTasks = tasksQuery.data?.items ?? [];
  const tasks = useMemo(() => {
    let t = rawTasks;
    if (hideDone) t = t.filter((x) => x.status.toLowerCase() !== 'done');
    return t;
  }, [rawTasks, hideDone]);

  const grouped = useMemo(() => groupByDueBucket(tasks), [tasks]);

  function openTask(t: Task): void {
    setSearchParams((sp) => {
      sp.set('task', t.id);
      return sp;
    });
  }
  function closeTask(): void {
    setSearchParams((sp) => {
      sp.delete('task');
      return sp;
    });
  }

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
          <span className="nockta-eyebrow text-brand">{'Personal'}</span>
          <h1
            className="display-heading mt-2 leading-[1.04]"
            style={{ fontSize: 'clamp(1.8rem, 3.4vw, 2.6rem)' }}
          >
            {'My tasks'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground max-w-xl">
            {"Everything you own across every project, grouped by when it's due."}
          </p>
        </div>
      </header>

      <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 flex-wrap">
        {/* View tabs */}
        <div className="flex items-center gap-1 rounded-md bg-secondary/60 p-1">
          {(
            [
              { id: 'board' as const, label: 'Board', icon: LayoutGrid },
              { id: 'list'  as const, label: 'List',  icon: ListIcon },
            ]
          ).map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setView(tab.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors',
                  view === tab.id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          <ToggleChip
            active={scope === 'assigned'}
            onClick={() => setScope('assigned')}
            label={'Assigned to me'}
          />
          <ToggleChip
            active={scope === 'watching'}
            onClick={() => setScope('watching')}
            label={'Watching'}
          />

          <Select
            value={projectId}
            onChange={setProjectId}
            label={'Project'}
          >
            <option value="">{'All projects'}</option>
            {(projectsQuery.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.key} · {p.name}</option>
            ))}
          </Select>

          <Select
            value={priority}
            onChange={(v) => setPriority(v as Priority | '')}
            label="Priority"
          >
            <option value="">All priorities</option>
            <option value="Critical">Critical</option>
            <option value="High">High</option>
            <option value="Medium">Medium</option>
            <option value="Low">Low</option>
          </Select>

          <ToggleChip
            active={hideDone}
            onClick={() => setHideDone(!hideDone)}
            label="Hide done"
          />

          <span className="nockta-eyebrow text-muted-foreground ml-2">
            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {tasksQuery.isLoading ? (
          <div className="p-6">
            <SkeletonList rows={8} rowClassName="h-14" />
          </div>
        ) : tasksQuery.isError ? (
          <QueryErrorState
            title="Couldn't load your tasks"
            error={tasksQuery.error}
            onRetry={() => void tasksQuery.refetch()}
          />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={<LayoutGrid className="h-5 w-5" />}
            title="You're all clear"
            description="Nothing matches the current filters. Drop a filter or press “c” to create a task."
          />
        ) : view === 'board' ? (
          <BoardView grouped={grouped} onOpen={openTask} />
        ) : (
          <ListView tasks={tasks} onOpen={openTask} />
        )}
      </div>

      {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />}
    </div>
  );
}

// =============================================================================
// Board: 5 columns by due-date bucket
// =============================================================================

function BoardView({
  grouped,
  onOpen,
}: {
  grouped: Map<Bucket, Task[]>;
  onOpen: (t: Task) => void;
}): JSX.Element {
  // Filter to buckets we'd actually render so the mobile dot strip and
  // carousel index don't count 'done' when it's empty (matches the desktop
  // skip-empty-done rule below).
  const visibleBuckets = BUCKET_ORDER.filter(
    (b) => !(b === 'done' && (grouped.get(b)?.length ?? 0) === 0),
  );

  // Mobile carousel — one bucket at a time. Same pattern as the project
  // board: matchMedia listener for breakpoint, touch swipe, arrow buttons,
  // dot strip indicator. The desktop grid is unchanged below.
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  const [mobileIdx, setMobileIdx] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    if (mobileIdx >= visibleBuckets.length && visibleBuckets.length > 0) {
      setMobileIdx(visibleBuckets.length - 1);
    }
  }, [visibleBuckets.length, mobileIdx]);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  function renderColumn(b: Bucket): JSX.Element {
    const items = grouped.get(b) ?? [];
    return (
      <div key={b} className="rounded-lg bg-secondary/30 flex flex-col">
        <div className="px-3 py-2.5 flex items-center justify-between border-b border-border">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <BucketIndicator bucket={b} />
            {BUCKET_LABELS[b]}
          </h2>
          <span className="text-xs text-muted-foreground font-mono">{items.length}</span>
        </div>
        <div className="p-2 space-y-2 flex-1 min-h-[200px]">
          {items.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onOpen(t)}
              className="cv-card w-full text-left rounded-md border border-border bg-card p-3 hover:border-ring transition-colors group"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 min-w-0">
                  <TypeBadge type={t.type ?? 'Task'} />
                  <span className="text-[11px] font-mono text-muted-foreground truncate">
                    {t.project?.key ? `${t.project.key}-${t.key.split('-').pop()}` : t.key}
                  </span>
                </span>
                <PriorityDot priority={t.priority} />
              </div>
              <div className="text-sm mt-1.5 font-medium leading-snug line-clamp-2">
                {t.title}
              </div>
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                <BlockedBadge blocked={t.isBlocked} />
                <DueDateChip dueDate={t.dueDate} done={t.status === 'Done'} />
              </div>
              <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-border/60">
                <span className="text-[10px] text-muted-foreground truncate">
                  {t.project?.name ?? '—'}
                </span>
                <StatusPill status={t.status} />
              </div>
            </button>
          ))}
          {items.length === 0 && (
            <div className="text-xs text-muted-foreground/60 text-center py-3">
              Nothing here
            </div>
          )}
        </div>
      </div>
    );
  }

  if (isMobile) {
    const safeIdx = Math.min(Math.max(0, mobileIdx), Math.max(0, visibleBuckets.length - 1));
    const activeBucket = visibleBuckets[safeIdx];
    return (
      <div
        className="flex flex-col h-full"
        onTouchStart={(e) => {
          const t = e.changedTouches[0];
          if (t) touchStartRef.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchEnd={(e) => {
          const start = touchStartRef.current;
          touchStartRef.current = null;
          const t = e.changedTouches[0];
          if (!start || !t) return;
          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx)) return;
          if (dx < 0) setMobileIdx((i) => Math.min(visibleBuckets.length - 1, i + 1));
          else setMobileIdx((i) => Math.max(0, i - 1));
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            setMobileIdx((i) => Math.min(visibleBuckets.length - 1, i + 1));
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setMobileIdx((i) => Math.max(0, i - 1));
          }
        }}
        tabIndex={-1}
      >
        <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 bg-card/30">
          <button
            type="button"
            onClick={() => setMobileIdx((i) => Math.max(0, i - 1))}
            disabled={safeIdx === 0}
            aria-label="Previous bucket"
            className="tap inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div
            className="flex-1 flex items-center justify-center gap-1.5"
            role="tablist"
            aria-label="Due-date buckets"
          >
            {visibleBuckets.map((b, i) => (
              <button
                key={b}
                type="button"
                role="tab"
                aria-selected={i === safeIdx}
                aria-label={BUCKET_LABELS[b]}
                onClick={() => setMobileIdx(i)}
                className={cn(
                  'tap h-2 rounded-full transition-all',
                  i === safeIdx
                    ? 'w-6 bg-foreground'
                    : 'w-2 bg-muted-foreground/40 hover:bg-muted-foreground/70',
                )}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() =>
              setMobileIdx((i) => Math.min(visibleBuckets.length - 1, i + 1))
            }
            disabled={safeIdx === visibleBuckets.length - 1}
            aria-label="Next bucket"
            className="tap inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {activeBucket && renderColumn(activeBucket)}
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-4 md:p-6">
      {/* Desktop: multi-column grid. Horizontal scroll only triggers when
          there are more buckets than fit (rare with 5 fixed columns) — this
          is the kanban exception the audit allows. */}
      <div className="grid grid-flow-col auto-cols-[minmax(280px,1fr)] gap-4 h-full overflow-x-auto">
        {visibleBuckets.map((b) => renderColumn(b))}
      </div>
    </div>
  );
}

function BucketIndicator({ bucket }: { bucket: Bucket }): JSX.Element {
  const cls = {
    overdue:    'bg-status-blocked',
    today:      'bg-priority-high',
    upcoming:   'bg-status-in-progress',
    'no-date':  'bg-muted-foreground',
    done:       'bg-status-done',
  }[bucket];
  return <span className={cn('h-1.5 w-1.5 rounded-full', cls)} />;
}

// =============================================================================
// List view: flat table grouped by bucket
// =============================================================================

function ListView({ tasks, onOpen }: { tasks: Task[]; onOpen: (t: Task) => void }): JSX.Element {
  const grouped = useMemo(() => groupByDueBucket(tasks), [tasks]);
  // Desktop: a wide multi-column grid. Mobile: each row becomes a stacked card
  // with the same fields, no horizontal scroll. The grouped bucket headers
  // remain as section dividers in both modes.
  return (
    <div className="p-3 sm:p-6 md:p-8">
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="hidden md:grid grid-cols-[24px_1.5fr_120px_60px_140px_120px] gap-3 px-3 py-2 bg-secondary/40 border-b border-border text-xs nockta-eyebrow text-muted-foreground">
          <span />
          <span>Name</span>
          <span>Status</span>
          <span className="text-center">Priority</span>
          <span>Project</span>
          <span>Due</span>
        </div>
        {BUCKET_ORDER.map((b) => {
          const items = grouped.get(b) ?? [];
          if (items.length === 0) return null;
          return (
            <div key={b}>
              <div className="grid grid-cols-[24px_1fr] items-center px-3 py-2 bg-card/40 border-b border-border">
                <BucketIndicator bucket={b} />
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{BUCKET_LABELS[b]}</span>
                  <span className="text-xs text-muted-foreground">{items.length}</span>
                </div>
              </div>
              {items.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onOpen(t)}
                  className="cv-row w-full text-left flex flex-col md:grid md:grid-cols-[24px_1.5fr_120px_60px_140px_120px] gap-2 md:gap-3 md:items-center px-3 py-2.5 border-b border-border last:border-b-0 hover:bg-accent/30 transition-colors"
                >
                  <span className="hidden md:inline text-muted-foreground/40 text-xs">·</span>
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <TypeBadge type={t.type ?? 'Task'} />
                    <span className="text-[11px] font-mono text-muted-foreground shrink-0">
                      {t.key}
                    </span>
                    <span className="text-sm font-medium truncate flex-1 min-w-0">{t.title}</span>
                    <BlockedBadge blocked={t.isBlocked} />
                  </div>
                  <div className="flex md:contents items-center gap-2 flex-wrap">
                    <StatusPill status={t.status} />
                    <span className="flex md:justify-center">
                      <PriorityDot priority={t.priority} />
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {t.project?.name ?? '—'}
                    </span>
                    <DueDateChip dueDate={t.dueDate} done={t.status === 'Done'} />
                  </div>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function groupByDueBucket(tasks: Task[]): Map<Bucket, Task[]> {
  const m = new Map<Bucket, Task[]>();
  for (const b of BUCKET_ORDER) m.set(b, []);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  for (const t of tasks) {
    let bucket: Bucket;
    if (t.status === 'Done') bucket = 'done';
    else if (!t.dueDate) bucket = 'no-date';
    else {
      const d = new Date(t.dueDate);
      if (d.getTime() < startOfToday.getTime()) bucket = 'overdue';
      else if (d.getTime() < startOfTomorrow.getTime()) bucket = 'today';
      else bucket = 'upcoming';
    }
    m.get(bucket)!.push(t);
  }
  return m;
}

function ToggleChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-brand/40 bg-accent text-foreground'
          : 'border-border bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}

function Select({
  value,
  onChange,
  label,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  const isActive = value !== '';
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
      {isActive && <span>{value}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        {children}
      </select>
    </label>
  );
}
