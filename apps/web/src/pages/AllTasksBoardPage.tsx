import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Play, Sun } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn, QueryErrorState, SkeletonList } from '@nockta/ui';

import {
  BoardToolbar,
  EMPTY_FILTERS,
  applyTaskFilters,
  type BoardView,
  type TaskFilters,
} from '../components/board-toolbar';
import { StandupRunner } from '../components/StandupRunner';
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
import { queryKeys } from '../lib/query-keys';

// =============================================================================
// /board — workspace-scope kanban. Aggregates tasks across every project the
// user can see and groups them on a generic 4-column axis (preset statuses
// mapped to Backlog / In Progress / In Review / Done).
//
// Uses the same BoardToolbar as project boards so saved views, multi-project
// filtering, and the standup runner all "just work" the same way they do on
// a project page. A saved view created here is a workspace-scope view: it
// has no projectId and shows up on /board for everyone who can see it.
// =============================================================================

interface Project {
  id: string;
  key: string;
  name: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
  archivedAt: string | null;
}

interface Task {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  parentTaskId?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  sprintId?: string | null;
  assignee?: { id: string; name: string; avatarUrl?: string | null };
  projectId: string;
}

// The column axis is preset-aware. When every project in the visible scope
// shares one workflow preset (e.g. user filtered Projects to engineering-only),
// we use the preset's exact status list — Todo, In Progress, In Review,
// Testing, Done — so the board feels native, not lossy.
//
// When projects across multiple presets are visible, we fall back to the
// 4-column generic axis below and bucket each task's status into the best
// match. That keeps the cross-preset board legible without inventing columns
// that only apply to half the tasks.
type Bucket = string;

const PRESET_STATUSES: Record<'engineering' | 'design' | 'generic', string[]> = {
  engineering: ['Todo', 'In Progress', 'In Review', 'Testing', 'Done'],
  design: ['Todo', 'In Progress', 'In Review', 'Approved', 'Done'],
  generic: ['Todo', 'In Progress', 'Done'],
};

const GENERIC_BUCKETS = ['Backlog', 'In Progress', 'In Review', 'Done'] as const;

/**
 * Maps preset-specific statuses to a generic 4-column axis.
 * Anything we don't recognize falls into Backlog (safest default).
 */
function genericBucketFor(status: string): typeof GENERIC_BUCKETS[number] {
  const s = status.toLowerCase();
  if (['done', 'approved', 'released', 'closed'].some((t) => s.includes(t))) return 'Done';
  if (['review', 'testing', 'qa'].some((t) => s.includes(t))) return 'In Review';
  if (['progress', 'designing', 'doing', 'active'].some((t) => s.includes(t))) return 'In Progress';
  return 'Backlog';
}

export function AllTasksBoardPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get('task');
  const initialView: BoardView = searchParams.get('view') === 'list' ? 'list' : 'board';
  const [view, setView] = useState<BoardView>(initialView);
  const [filters, setFilters] = useState<TaskFilters>(() => ({ ...EMPTY_FILTERS }));
  const [standupOpen, setStandupOpen] = useState(false);
  // Save the user's assignee filter so we can restore it after the standup
  // ends — same pattern as the project board's standup integration.
  const preStandupAssigneeFilter = useRef<string | undefined | null>(null);

  // Mobile carousel state — one bucket at a time. Same pattern as
  // ProjectBoardPage; this board has no dnd-kit drag setup so we don't need
  // to coordinate with sortable contexts.
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  const [mobileColumnIdx, setMobileColumnIdx] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleSpeakerChange = useCallback(
    (userId: string | null) => {
      setFilters((prev) => {
        if (preStandupAssigneeFilter.current === null && userId !== null) {
          preStandupAssigneeFilter.current = prev.assigneeUserId;
        }
        if (userId === null) {
          const restore = preStandupAssigneeFilter.current;
          preStandupAssigneeFilter.current = null;
          return { ...prev, assigneeUserId: restore ?? undefined };
        }
        const filterValue = userId === '__unassigned__' ? 'unassigned' : userId;
        return { ...prev, assigneeUserId: filterValue };
      });
    },
    [],
  );

  // Apply a saved workspace view via ?savedView=ID. Fetches /saved-views,
  // looks up the matching id, applies its filters + view, then strips the
  // param so subsequent toolbar changes don't get clobbered on URL update.
  // Same pattern the project board uses — keeps sidebar "Boards" links working.
  const savedViewParam = searchParams.get('savedView');
  const savedViewsQuery = useQuery({
    queryKey: queryKeys.savedViews(),
    queryFn: () =>
      api.get<{ id: string; query: { projectId?: string; filters: TaskFilters; view: BoardView } }[]>('/saved-views'),
    enabled: Boolean(savedViewParam),
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!savedViewParam) return;
    const list = savedViewsQuery.data;
    if (!list) return;
    const match = list.find((v) => v.id === savedViewParam);
    if (match) {
      if (match.query.filters) setFilters(match.query.filters);
      if (match.query.view) setView(match.query.view);
    }
    setSearchParams((sp) => {
      sp.delete('savedView');
      return sp;
    }, { replace: true });
  }, [savedViewParam, savedViewsQuery.data, setFilters, setView, setSearchParams]);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<Project[]>('/projects'),
  });
  const projects = useMemo(
    () => (projectsQuery.data ?? []).filter((p) => !p.archivedAt),
    [projectsQuery.data],
  );

  // Fetch tasks for every visible project in parallel. A more efficient path
  // would be a dedicated /tasks endpoint with cross-project pagination, but
  // for typical workspace sizes this is fine.
  const tasksQuery = useQuery({
    queryKey: ['tasks', 'all-projects', projects.map((p) => p.id).join(',')],
    queryFn: async () => {
      const results = await Promise.all(
        projects.map((p) =>
          api
            .get<Task[]>(`/tasks/project/${p.id}`)
            .then((rows) => rows.map((r) => ({ ...r, projectId: p.id })))
            .catch(() => [] as Task[]),
        ),
      );
      return results.flat();
    },
    enabled: projects.length > 0,
  });

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const allTasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);

  // Hide children — they belong nested under their parent in the drawer.
  // Skipping them keeps the cross-project board from showing the same story
  // twice (once as a card, once as a row under its epic).
  const visibleTasks = useMemo(() => {
    const top = allTasks.filter((t) => !t.parentTaskId);
    return applyTaskFilters(top, filters);
  }, [allTasks, filters]);

  // Derive the live column axis from the visible projects' presets. If they
  // all share one preset, use its native statuses; otherwise fall back to
  // the generic 4-column axis. Recomputed when filters change so picking a
  // single Engineering project shows the native columns immediately.
  const buckets = useMemo<Bucket[]>(() => {
    const projectIdSet =
      filters.projectIds && filters.projectIds.length > 0
        ? new Set(filters.projectIds)
        : null;
    const presets = new Set(
      projects
        .filter((p) => !projectIdSet || projectIdSet.has(p.id))
        .map((p) => p.workflowPreset),
    );
    if (presets.size === 1) {
      const [only] = Array.from(presets);
      return PRESET_STATUSES[only as keyof typeof PRESET_STATUSES];
    }
    return [...GENERIC_BUCKETS];
  }, [projects, filters.projectIds]);

  // Pick the right bucket for a task given the current axis. When we're on the
  // native preset axis, match the status verbatim (case-insensitive); on the
  // generic axis, fall back to the keyword mapping.
  const bucketFor = useCallback(
    (status: string): Bucket => {
      // Native-axis path: try an exact (case-insensitive) match first.
      const lower = status.toLowerCase();
      const native = buckets.find((b) => b.toLowerCase() === lower);
      if (native) return native;
      // Cross-preset path: bucket into Generic. If "Generic" doesn't have this
      // either (which can happen if the axis is preset-specific), drop into
      // the leftmost column so nothing disappears.
      const fallback = genericBucketFor(status);
      return buckets.includes(fallback) ? fallback : (buckets[0] ?? 'Backlog');
    },
    [buckets],
  );

  const byBucket = useMemo(() => {
    const m = new Map<Bucket, Task[]>();
    for (const b of buckets) m.set(b, []);
    for (const t of visibleTasks) m.get(bucketFor(t.status))?.push(t);
    return m;
  }, [visibleTasks, buckets, bucketFor]);

  // Clamp the mobile carousel index when the bucket axis changes (e.g.
  // filtering down to a single preset reduces column count).
  useEffect(() => {
    if (mobileColumnIdx >= buckets.length && buckets.length > 0) {
      setMobileColumnIdx(buckets.length - 1);
    }
  }, [buckets.length, mobileColumnIdx]);

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

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-end justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="nockta-eyebrow text-muted-foreground">Workspace</p>
          <h1 className="display-heading text-xl sm:text-2xl mt-1 truncate">All tasks</h1>
          <p className="nockta-eyebrow text-muted-foreground/70 mt-1.5 flex items-center gap-2">
            <span>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span>
            <span aria-hidden="true" className="h-1 w-1 rounded-full bg-muted-foreground/40" />
            <span>{visibleTasks.length} {visibleTasks.length === 1 ? 'task' : 'tasks'} in view</span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {standupOpen ? (
            <button
              type="button"
              onClick={() => setStandupOpen(false)}
              className="tap inline-flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand/15 px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-brand/20 transition-colors"
              title="End standup (Esc)"
            >
              <Sun className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">End standup</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStandupOpen(true)}
              className="tap inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              title="Start a team standup over the filtered tasks"
            >
              <Play className="h-3 w-3" />
              <span className="hidden sm:inline">Standup</span>
            </button>
          )}
        </div>
      </header>

      <BoardToolbar
        view={view}
        onViewChange={setView}
        filters={filters}
        onFiltersChange={setFilters}
        taskCount={visibleTasks.length}
        tasks={visibleTasks}
        availableProjects={projects.map((p) => ({ id: p.id, key: p.key, name: p.name }))}
      />

      {/* Body — flex row so the StandupRunner sits as a leftmost column when on. */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {standupOpen && (
          <StandupRunner
            tasks={visibleTasks}
            onClose={() => setStandupOpen(false)}
            onSpeakerChange={handleSpeakerChange}
          />
        )}
        {tasksQuery.isError ? (
          <div className="flex-1">
            <QueryErrorState
              title="Couldn't load tasks"
              error={tasksQuery.error}
              onRetry={() => void tasksQuery.refetch()}
            />
          </div>
        ) : tasksQuery.isLoading ? (
          <div className="flex-1 p-6">
            <SkeletonList rows={8} rowClassName="h-14" />
          </div>
        ) : view === 'board' ? (
          isMobile ? (
            // Mobile carousel — one bucket visible at a time, swipe or use
            // dot strip / arrows to page. Matches the per-project board so
            // users get one mental model for kanban on phones.
            (() => {
              const safeIdx = Math.min(
                Math.max(0, mobileColumnIdx),
                Math.max(0, buckets.length - 1),
              );
              const activeBucket = buckets[safeIdx];
              return (
                <div
                  className="flex-1 flex flex-col min-h-0"
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
                    if (dx < 0) {
                      setMobileColumnIdx((i) => Math.min(buckets.length - 1, i + 1));
                    } else {
                      setMobileColumnIdx((i) => Math.max(0, i - 1));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowRight') {
                      e.preventDefault();
                      setMobileColumnIdx((i) => Math.min(buckets.length - 1, i + 1));
                    } else if (e.key === 'ArrowLeft') {
                      e.preventDefault();
                      setMobileColumnIdx((i) => Math.max(0, i - 1));
                    }
                  }}
                  tabIndex={-1}
                >
                  <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 bg-card/30">
                    <button
                      type="button"
                      onClick={() => setMobileColumnIdx((i) => Math.max(0, i - 1))}
                      disabled={safeIdx === 0}
                      aria-label="Previous column"
                      className="tap inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <div
                      className="flex-1 flex items-center justify-center gap-1.5"
                      role="tablist"
                      aria-label="Board columns"
                    >
                      {buckets.map((b, i) => (
                        <button
                          key={b}
                          type="button"
                          role="tab"
                          aria-selected={i === safeIdx}
                          aria-label={b}
                          onClick={() => setMobileColumnIdx(i)}
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
                        setMobileColumnIdx((i) => Math.min(buckets.length - 1, i + 1))
                      }
                      disabled={safeIdx === buckets.length - 1}
                      aria-label="Next column"
                      className="tap inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3">
                    {activeBucket && (
                      <Column
                        key={activeBucket}
                        title={activeBucket}
                        tasks={byBucket.get(activeBucket) ?? []}
                        projectById={projectById}
                        onOpen={openTask}
                      />
                    )}
                  </div>
                </div>
              );
            })()
          ) : (
            // Desktop: multi-column grid. Horizontal scroll only kicks in
            // when there are more bucket columns than fit the viewport —
            // this is the kanban exception the audit explicitly allows.
            <div className="flex-1 overflow-x-auto p-3 sm:p-4 md:p-6">
              <div className="grid grid-flow-col auto-cols-[minmax(280px,1fr)] gap-4 h-full">
                {buckets.map((b) => (
                  <Column
                    key={b}
                    title={b}
                    tasks={byBucket.get(b) ?? []}
                    projectById={projectById}
                    onOpen={openTask}
                  />
                ))}
              </div>
            </div>
          )
        ) : (
          <div className="flex-1 overflow-auto p-3 sm:p-4 md:p-6">
            <ListView tasks={visibleTasks} projectById={projectById} onOpen={openTask} />
          </div>
        )}
      </div>

      {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />}
    </div>
  );
}

// =============================================================================

function Column({
  title,
  tasks,
  projectById,
  onOpen,
}: {
  title: Bucket;
  tasks: Task[];
  projectById: Map<string, Project>;
  onOpen: (id: string) => void;
}): JSX.Element {
  const statusDotClass = COLUMN_STATUS_DOT[title] ?? 'bg-muted-foreground/40';
  return (
    <div className="flex flex-col min-h-0">
      <header className="flex items-center justify-between px-1 pb-2 mb-2 border-b border-border/70">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', statusDotClass)} />
          <span className="nockta-eyebrow text-foreground">{title}</span>
          <span className="font-mono text-[10px] text-muted-foreground/70">{tasks.length}</span>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto space-y-1.5 pb-2">
        {tasks.length === 0 ? (
          <p className="nockta-eyebrow text-muted-foreground/40 px-1 py-6 text-center">
            Empty
          </p>
        ) : (
          tasks.map((t) => {
            const proj = projectById.get(t.projectId);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onOpen(t.id)}
                className="cv-card board-card group w-full text-left rounded-md border border-border bg-card hover:bg-secondary/60 transition-colors px-3 py-2.5"
              >
                <div className="flex items-center gap-2 mb-1.5 min-w-0">
                  <TypeBadge type={t.type ?? 'Task'} />
                  <span className="font-mono text-[10px] text-muted-foreground/80">{t.key}</span>
                  {proj && (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 truncate">
                      {proj.key}
                    </span>
                  )}
                  <span className="flex-1" />
                  <PriorityDot priority={t.priority} />
                </div>
                <div className="text-sm leading-snug text-foreground line-clamp-2">{t.title}</div>
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <BlockedBadge blocked={t.isBlocked} />
                    {t.dueDate && <DueDateChip dueDate={t.dueDate} done={t.status === 'Done'} />}
                  </div>
                  {t.assignee && <AvatarCircle user={t.assignee} size={20} />}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// Status indicator dot per column header. Pairs colour with the eyebrow label
// so colour is never the only signal (per the keyboard-first accessibility
// rule in PRODUCT.md) and so the columns scan top-to-bottom like an
// instrument readout.
const COLUMN_STATUS_DOT: Record<string, string> = {
  Todo: 'bg-status-todo',
  'In Progress': 'bg-status-in-progress',
  'In Review': 'bg-status-in-review',
  Testing: 'bg-status-testing',
  Approved: 'bg-status-done',
  Done: 'bg-status-done',
};

function ListView({
  tasks,
  projectById,
  onOpen,
}: {
  tasks: Task[];
  projectById: Map<string, Project>;
  onOpen: (id: string) => void;
}): JSX.Element {
  if (tasks.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing matches your filters.</p>;
  }
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="hidden md:grid grid-cols-[80px_1.5fr_100px_120px_60px_140px_120px] gap-3 px-3 py-2 bg-secondary/40 border-b border-border text-xs nockta-eyebrow text-muted-foreground">
        <span>Project</span>
        <span>Name</span>
        <span>Key</span>
        <span>Status</span>
        <span className="text-center">Priority</span>
        <span>Assignee</span>
        <span>Due</span>
      </div>
      {tasks.map((t) => {
        const proj = projectById.get(t.projectId);
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onOpen(t.id)}
            className="cv-row w-full flex flex-col md:grid md:grid-cols-[80px_1.5fr_100px_120px_60px_140px_120px] gap-2 md:gap-3 md:items-center px-3 py-2.5 border-b border-border last:border-b-0 hover:bg-accent/30 transition text-left"
          >
            <div className="flex items-center gap-2 min-w-0 flex-wrap md:contents">
              <span className="text-[10px] font-mono text-muted-foreground truncate">{proj?.key}</span>
              <span className="flex items-center gap-1.5 min-w-0 flex-1 md:flex-initial">
                <TypeBadge type={t.type ?? 'Task'} />
                <span className="text-sm font-medium truncate">{t.title}</span>
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">{t.key}</span>
            </div>
            <div className="flex md:contents items-center gap-2 flex-wrap">
              <StatusPill status={t.status} />
              <span className="flex md:justify-center">
                <PriorityDot priority={t.priority} />
              </span>
              <span className="text-xs text-muted-foreground truncate">
                {t.assignee ? (
                  <span className="inline-flex items-center gap-1.5">
                    <AvatarCircle user={t.assignee} size={16} />
                    {t.assignee.name}
                  </span>
                ) : (
                  'Unassigned'
                )}
              </span>
              <span className="text-xs text-muted-foreground/50">
                {t.dueDate ? <DueDateChip dueDate={t.dueDate} done={t.status === 'Done'} /> : <span aria-hidden="true">·</span>}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
