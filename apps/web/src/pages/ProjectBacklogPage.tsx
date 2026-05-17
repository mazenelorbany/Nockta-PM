import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Inbox,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Sparkles,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { cn, NocktaMark, QueryErrorState, Spinner } from '@nockta/ui';
import { ProjectTabs } from '../components/ProjectTabs';
import { TaskDetailDrawer } from '../components/TaskDetailDrawer';
import { PullIndicator, usePullToRefresh } from '../hooks/usePullToRefresh';
import {
  AvatarCircle,
  BlockedBadge,
  PriorityDot,
  StatusPill,
  TypeBadge,
  type Priority,
  type TaskType,
} from '../components/task-bits';
import { api } from '../lib/api';

// =============================================================================
// /projects/:projectId/backlog
// Jira/ClickUp-style backlog manager: every planned sprint + the active sprint
// + the backlog, all on one page. Drag tasks between any of them. The backlog
// section is always at the bottom and never collapses by default so you can
// always see what's waiting.
// =============================================================================

interface Project {
  id: string;
  key: string;
  name: string;
  sprintsEnabled: boolean;
  workflowPreset: 'engineering' | 'design' | 'generic';
}

interface Sprint {
  id: string;
  projectId: string;
  name: string;
  state: 'planned' | 'active' | 'completed';
  startDate: string | null;
  endDate: string | null;
  /** Free-text sprint theme / goal (≤200 chars). Surfaced as a one-line
   *  banner under each sprint header so the goal is visible at all times. */
  goal: string | null;
  _count?: { tasks: number };
}

interface Label {
  id: string;
  name: string;
  color: string;
}

interface PlannerTask {
  id: string;
  key: string;
  title: string;
  status: string;
  priority: Priority;
  type?: TaskType;
  isBlocked: boolean;
  estimate: number | null;
  dueDate: string | null;
  assignee?: { id: string; name: string; avatarUrl?: string | null } | null;
  labels: Label[];
  _count?: { subtasks: number };
}

type ContainerId = string; // 'backlog' or sprint UUID

export function ProjectBacklogPage(): JSX.Element {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get('task');
  const queryClient = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const sprintsQuery = useQuery({
    queryKey: ['sprints', projectId],
    queryFn: () => api.get<Sprint[]>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId),
  });
  const backlogQuery = useQuery({
    queryKey: ['backlog', projectId],
    queryFn: () => api.get<PlannerTask[]>(`/projects/${projectId}/backlog`),
    enabled: Boolean(projectId),
  });
  // Historical velocity drives the per-sprint capacity baseline. We pull it
  // once and let the sprints render their own warning chip locally — saves a
  // request-per-sprint pattern. Returns empty `sprints: []` for projects
  // without completed history, which the chip handles by hiding itself.
  const velocityQuery = useQuery({
    queryKey: ['velocity', projectId],
    queryFn: () =>
      api.get<{
        sprints: { sprintId: string; completedEstimate: number }[];
        averageEstimate: number;
      }>(`/analytics/projects/${projectId}/velocity`),
    enabled: Boolean(projectId),
  });

  const project = projectQuery.data;
  const sprints = sprintsQuery.data ?? [];
  const backlog = backlogQuery.data ?? [];

  // Active sprint first, then planned sprints (oldest first), then backlog at the bottom.
  // Completed sprints are hidden by default — toggle reveals them.
  const [showCompleted, setShowCompleted] = useState(false);
  const orderedSprints = useMemo(() => {
    const active = sprints.filter((s) => s.state === 'active');
    const planned = sprints.filter((s) => s.state === 'planned');
    const completed = sprints.filter((s) => s.state === 'completed');
    return [...active, ...planned, ...(showCompleted ? completed : [])];
  }, [sprints, showCompleted]);

  // ---------- Filters ----------
  const [search, setSearch] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<Priority | ''>('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Fetch the tasks for every visible sprint in one go. Each sprint query is
  // independent so refetches stay cheap.
  const sprintTasksQueries = orderedSprints.map((s) =>
    useSprintTasks(s.id, projectId)
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['backlog', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
    for (const s of orderedSprints) {
      void queryClient.invalidateQueries({ queryKey: ['sprint-tasks', s.id] });
    }
    void queryClient.invalidateQueries({ queryKey: ['tasks', 'project', projectId] });
  };

  const moveOne = useMutation({
    mutationFn: async ({ taskId, to }: { taskId: string; to: ContainerId }) => {
      if (to === 'backlog') {
        // The DELETE endpoint requires a source sprint, so we find which one
        // currently holds the task by scanning loaded data.
        for (const q of sprintTasksQueries) {
          if (q.data?.some((t) => t.id === taskId)) {
            return api.delete(`/sprints/${q.sprintId}/tasks/${taskId}`);
          }
        }
        // Fall back to "patch the task" if we couldn't locate it client-side.
        return api.patch(`/tasks/${taskId}`, { sprintId: null });
      }
      return api.post(`/sprints/${to}/tasks`, { taskIds: [taskId] });
    },
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not move task')),
  });
  const bulkMove = useMutation({
    mutationFn: async ({ taskIds, to }: { taskIds: string[]; to: ContainerId }) => {
      if (to === 'backlog') {
        // Sequentially detach each task. There are at most a few-hundred in
        // any realistic bulk move; chunking isn't worth the complexity.
        await Promise.all(
          taskIds.map((taskId) => {
            for (const q of sprintTasksQueries) {
              if (q.data?.some((t) => t.id === taskId)) {
                return api.delete(`/sprints/${q.sprintId}/tasks/${taskId}`);
              }
            }
            return api.patch(`/tasks/${taskId}`, { sprintId: null });
          })
        );
        return;
      }
      await api.post(`/sprints/${to}/tasks`, { taskIds });
    },
    onSuccess: (_, vars) => {
      const target = vars.to === 'backlog'
        ? 'backlog'
        : orderedSprints.find((s) => s.id === vars.to)?.name ?? 'sprint';
      toast.success(`Moved ${vars.taskIds.length} ${vars.taskIds.length === 1 ? 'task' : 'tasks'} → ${target}`);
      invalidate();
      setSelected(new Set());
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Bulk move failed')),
  });
  const startSprint = useMutation({
    mutationFn: (sprintId: string) => api.post(`/sprints/${sprintId}/start`),
    onSuccess: () => {
      toast.success('Sprint started');
      invalidate();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not start sprint')),
  });
  const completeSprint = useMutation({
    mutationFn: (sprintId: string) =>
      api.post(`/sprints/${sprintId}/complete`, { moveIncompleteTo: 'backlog' }),
    onSuccess: () => {
      toast.success('Sprint completed');
      invalidate();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not complete sprint')),
  });
  const deleteSprint = useMutation({
    mutationFn: (sprintId: string) => api.delete(`/sprints/${sprintId}`),
    onSuccess: () => {
      toast.success('Sprint deleted');
      invalidate();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete sprint')),
  });
  const [createSprintOpen, setCreateSprintOpen] = useState(false);
  // Holds the sprint that "Plan with AI" was clicked from. When non-null, the
  // PlanWithAiDialog overlay renders with the AI-ranked task list for that
  // sprint. Per-sprint state (not global) so the dialog knows which sprint to
  // move accepted tasks into.
  const [planWithAiFor, setPlanWithAiFor] = useState<Sprint | null>(null);

  // Collect unique assignees across every visible list for the filter dropdown.
  const assigneeOptions = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const t of backlog) if (t.assignee) m.set(t.assignee.id, { id: t.assignee.id, name: t.assignee.name });
    for (const q of sprintTasksQueries) {
      for (const t of q.data ?? []) {
        if (t.assignee) m.set(t.assignee.id, { id: t.assignee.id, name: t.assignee.name });
      }
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [backlog, sprintTasksQueries.map((q) => q.data).join('|')]);

  function filterFor(rows: PlannerTask[]): PlannerTask[] {
    return applyFilters(rows, search, assigneeFilter, priorityFilter);
  }

  // ---------- Drag-and-drop ----------
  const [dragging, setDragging] = useState<{ id: string; from: ContainerId } | null>(null);
  function onDragStart(e: DragStartEvent): void {
    const data = e.active.data.current as { from: ContainerId } | undefined;
    if (data) setDragging({ id: e.active.id as string, from: data.from });
  }
  function onDragEnd(e: DragEndEvent): void {
    setDragging(null);
    const overId = e.over?.id;
    const data = e.active.data.current as { from: ContainerId } | undefined;
    if (!overId || !data) return;
    const target = String(overId).replace(/^pane-/, '');
    if (data.from === target) return;
    moveOne.mutate({ taskId: e.active.id as string, to: target });
  }

  function openTask(taskId: string): void {
    setSearchParams((sp) => {
      sp.set('task', taskId);
      return sp;
    });
  }
  function closeTask(): void {
    setSearchParams((sp) => {
      sp.delete('task');
      return sp;
    });
  }

  // Pull-to-refresh on the backlog scroll container — refetches sprints +
  // backlog + per-sprint tasks via TanStack's broad-by-key invalidate.
  //
  // IMPORTANT: this hook MUST sit before the early returns below — otherwise
  // the first render (project still loading) calls fewer hooks than the
  // second (project loaded), which trips React's hook-order invariant and
  // throws "Rendered more hooks than during the previous render."
  const pull = usePullToRefresh({
    onRefresh: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sprints', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['backlog', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['sprint-tasks'] }),
      ]);
    },
  });

  // ---------- Empty / disabled states ----------
  if (projectQuery.isError) {
    return (
      <QueryErrorState
        title="Couldn't load this project"
        error={projectQuery.error}
        onRetry={() => void projectQuery.refetch()}
        className="py-16"
      />
    );
  }
  if (!project) {
    return (
      <div className="p-8 text-sm text-muted-foreground flex items-center gap-2">
        <Spinner /> Loading…
      </div>
    );
  }
  if (!project.sprintsEnabled) {
    return (
      <SprintsDisabledState projectId={projectId} projectName={project.name} />
    );
  }

  const filteredBacklog = filterFor(backlog);
  const totalFilteredCount =
    filteredBacklog.length +
    sprintTasksQueries.reduce((acc, q) => acc + filterFor(q.data ?? []).length, 0);

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex flex-col h-full">
        {/* Slim header — matches the project board's */}
        <header className="px-4 sm:px-6 md:px-8 py-3 sm:py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-baseline gap-3 min-w-0">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">
              {project.key}
            </span>
            <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate">{project.name}</h1>
            <span className="text-muted-foreground/60 hidden sm:inline">·</span>
            <span className="text-sm text-muted-foreground hidden sm:inline">
              {t('project_backlog.title', 'Backlog & sprints')}
            </span>
          </div>
        </header>

        <ProjectTabs
          projectId={projectId}
          actions={
            <button
              type="button"
              onClick={() => setCreateSprintOpen(true)}
              className="tap inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 h-8 text-xs font-semibold hover:opacity-90 transition-opacity"
            >
              <Plus className="h-3.5 w-3.5" />
              New sprint
            </button>
          }
        />

        {/* Toolbar */}
        <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-2 flex-wrap">
          <label className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search every task…"
              className="h-7 w-full sm:w-72 rounded-md bg-secondary/60 pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
            />
          </label>
          <Pill
            label="Assignee"
            value={assigneeFilter}
            onChange={setAssigneeFilter}
            options={[{ value: '', label: 'Anyone' }, ...assigneeOptions.map((u) => ({ value: u.id, label: u.name }))]}
          />
          <Pill
            label="Priority"
            value={priorityFilter}
            onChange={(v) => setPriorityFilter(v as Priority | '')}
            options={[
              { value: '', label: 'All priorities' },
              { value: 'Critical', label: 'Critical' },
              { value: 'High', label: 'High' },
              { value: 'Medium', label: 'Medium' },
              { value: 'Low', label: 'Low' },
            ]}
          />
          {(search || assigneeFilter || priorityFilter) && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setAssigneeFilter('');
                setPriorityFilter('');
              }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
          <span className="nockta-eyebrow text-muted-foreground ml-1">
            {totalFilteredCount} visible
          </span>
          <div className="ml-auto flex items-center gap-2">
            {selected.size > 0 && (
              <BulkMoveMenu
                count={selected.size}
                sprints={orderedSprints.filter((s) => s.state !== 'completed')}
                onMove={(to) => bulkMove.mutate({ taskIds: Array.from(selected), to })}
                onClear={() => setSelected(new Set())}
              />
            )}
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={showCompleted}
                onChange={(e) => setShowCompleted(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Show completed
            </label>
          </div>
        </div>

        <PullIndicator state={pull} />
        {/* Sections */}
        <div ref={pull.ref} className="flex-1 overflow-y-auto px-3 sm:px-6 md:px-8 py-4 space-y-3">
          {orderedSprints.map((s, idx) => {
            const q = sprintTasksQueries[idx];
            const tasks = filterFor(q?.data ?? []);
            const isReady = (q?.data ?? []).length > 0;
            return (
              <Section
                key={s.id}
                id={`pane-${s.id}`}
                droppableId={s.id}
                title={s.name}
                icon={<Target className={cn('h-3.5 w-3.5', s.state === 'active' ? 'text-primary' : 'text-muted-foreground')} />}
                state={s.state}
                dates={[s.startDate, s.endDate]}
                tasks={tasks}
                totalCount={q?.data?.length ?? 0}
                isDragHighlight={dragging != null && dragging.from !== s.id}
                velocityBaseline={velocityQuery.data?.averageEstimate ?? null}
                actions={
                  <SprintHeaderActions
                    sprint={s}
                    canStart={s.state === 'planned' && isReady && !sprints.some((x) => x.state === 'active')}
                    onStart={() => {
                      if (window.confirm(`Start "${s.name}"?`)) startSprint.mutate(s.id);
                    }}
                    onComplete={() => {
                      if (window.confirm(`Complete "${s.name}"? Incomplete tasks move back to backlog.`)) {
                        completeSprint.mutate(s.id);
                      }
                    }}
                    onDelete={() => {
                      if (window.confirm(`Delete sprint "${s.name}"? This can't be undone.`)) {
                        deleteSprint.mutate(s.id);
                      }
                    }}
                    onPlan={() => setPlanWithAiFor(s)}
                    projectId={projectId}
                  />
                }
                afterBody={
                  <>
                    <SprintGoalRow
                      sprintId={s.id}
                      projectId={projectId}
                      goal={s.goal}
                      state={s.state}
                    />
                    {(s.state === 'active' || s.state === 'completed') && (
                      <SprintAiSummary sprintId={s.id} />
                    )}
                  </>
                }
                selected={selected}
                onToggleSelect={(id) => toggleSelected(setSelected, id)}
                onOpenTask={openTask}
                emptyMessage={
                  s.state === 'planned'
                    ? 'Empty — drag tasks here from the backlog below to plan this sprint.'
                    : s.state === 'active'
                    ? 'Active sprint with no tasks. Add some, then move them across the board.'
                    : 'Sprint complete.'
                }
              />
            );
          })}

          {/* Backlog (always last) */}
          <Section
            id="pane-backlog"
            droppableId="backlog"
            title="Backlog"
            icon={<Inbox className="h-3.5 w-3.5 text-muted-foreground" />}
            tasks={filteredBacklog}
            totalCount={backlog.length}
            isDragHighlight={dragging != null && dragging.from !== 'backlog'}
            actions={
              <Link
                to={`/projects/${projectId}/board`}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3 w-3" /> New task
              </Link>
            }
            selected={selected}
            onToggleSelect={(id) => toggleSelected(setSelected, id)}
            onOpenTask={openTask}
            emptyMessage="Backlog empty. Either you're caught up or every task is in a sprint already."
          />
        </div>

        {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />}
        {createSprintOpen && (
          <CreateSprintDialog
            projectId={projectId}
            onClose={() => setCreateSprintOpen(false)}
          />
        )}
        {planWithAiFor && (
          <PlanWithAiDialog
            projectId={projectId}
            sprint={planWithAiFor}
            onClose={() => setPlanWithAiFor(null)}
            onAccepted={() => {
              void queryClient.invalidateQueries({ queryKey: ['backlog', projectId] });
              void queryClient.invalidateQueries({ queryKey: ['sprint-tasks', planWithAiFor.id] });
              setPlanWithAiFor(null);
            }}
          />
        )}
      </div>
    </DndContext>
  );
}

// =============================================================================
// Section — one collapsible droppable container with its own task list.
// =============================================================================

function Section({
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
// BacklogRow — compact, single-line draggable task row.
// =============================================================================

function BacklogRow({
  task,
  from,
  isSelected,
  onToggleSelect,
  onOpen,
}: {
  task: PlannerTask;
  from: ContainerId;
  isSelected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
}): JSX.Element {
  const { setNodeRef, attributes, listeners, transform, isDragging } = useDraggable({
    id: task.id,
    data: { from },
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group grid grid-cols-[20px_60px_80px_1fr_auto] gap-2 items-center rounded-md px-2 py-1.5 text-xs transition',
        'hover:bg-accent/40',
        isSelected && 'bg-primary/5 hover:bg-primary/10',
        isDragging && 'opacity-50',
      )}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggleSelect}
        className={cn(
          'h-3.5 w-3.5 cursor-pointer',
          isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
        aria-label={`Select ${task.key}`}
      />
      <button
        type="button"
        {...listeners}
        {...attributes}
        className="font-mono text-[10px] text-muted-foreground text-left cursor-grab active:cursor-grabbing truncate"
      >
        {task.key}
      </button>
      <div className="flex items-center gap-1.5 min-w-0">
        {task.type && <TypeBadge type={task.type} />}
        <PriorityDot priority={task.priority} />
        <BlockedBadge blocked={task.isBlocked} />
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="text-sm font-medium truncate text-left hover:underline"
        title={task.title}
      >
        {task.title}
      </button>
      <div className="flex items-center gap-2 justify-end">
        <StatusPill status={task.status} />
        {task.labels.slice(0, 2).map((l) => (
          <span
            key={l.id}
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ backgroundColor: `#${l.color}22`, color: `#${l.color}` }}
          >
            {l.name}
          </span>
        ))}
        {task.labels.length > 2 && (
          <span className="text-[10px] text-muted-foreground">+{task.labels.length - 2}</span>
        )}
        {task.estimate !== null && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground tabular-nums">
            <Clock className="h-3 w-3" /> {task.estimate}
          </span>
        )}
        {task.assignee ? (
          <AvatarCircle user={task.assignee} size={20} />
        ) : (
          <span className="h-5 w-5 rounded-full border border-dashed border-border" title="Unassigned" />
        )}
      </div>
    </div>
  );
}

// =============================================================================
// SprintHeaderActions — Start / Complete / Plan / View board buttons.
// =============================================================================

function SprintHeaderActions({
  sprint,
  canStart,
  onStart,
  onComplete,
  onDelete,
  onPlan,
  projectId,
}: {
  sprint: Sprint;
  canStart: boolean;
  onStart: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onPlan: () => void;
  projectId: string;
}): JSX.Element {
  return (
    <>
      {sprint.state === 'planned' && (
        <button
          type="button"
          onClick={onPlan}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-brand/5 px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/10 transition"
          title="Open the AI-ranked task suggestion modal for this sprint"
        >
          <Sparkles className="h-3 w-3" />
          Plan with AI
        </button>
      )}
      <Link
        to={`/projects/${projectId}/sprints/${sprint.id}/plan`}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition"
      >
        Plan
      </Link>
      {sprint.state === 'active' && (
        <Link
          to={`/projects/${projectId}/board?sprint=${sprint.id}`}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition"
        >
          Board
        </Link>
      )}
      {sprint.state === 'planned' && (
        <button
          type="button"
          onClick={onStart}
          disabled={!canStart}
          title={canStart ? 'Start sprint' : 'Add at least one task and stop any active sprint first'}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition"
        >
          <Play className="h-3 w-3" />
          Start
        </button>
      )}
      {sprint.state === 'active' && (
        <button
          type="button"
          onClick={onComplete}
          className="inline-flex items-center gap-1 rounded-md bg-status-done/80 px-2 py-1 text-[11px] font-medium text-white hover:bg-status-done transition"
        >
          Complete
        </button>
      )}
      {/* Pass I (Sprints 8→9). The "Run retro" button shows on completed
          sprints so the team can capture went-well / could-improve / action
          items in the same place they ended the sprint. */}
      {sprint.state === 'completed' && (
        <RunRetroButton sprintId={sprint.id} />
      )}
      {sprint.state === 'planned' && (
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center justify-center rounded-md w-7 h-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          aria-label="Delete sprint"
          title="Delete sprint"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </>
  );
}

// =============================================================================
// Pass I (Sprints 8 → 9). Run retro button + modal.
//
// The button only ever shows on completed sprints. Clicking opens a modal
// with the three classic retro fields plus an action-item editor. The
// modal also captures a goal-evaluation (boolean + optional note) since the
// retro is the moment when teams naturally reflect on whether the sprint
// goal was hit — the two records live in separate tables but are saved in
// quick succession from the same form.
// =============================================================================

interface RetroResponse {
  id: string;
  whatWentWell: string | null;
  whatCouldImprove: string | null;
  actionItems: Array<{
    id: string;
    description: string;
    ownerUserId: string | null;
    status: 'open' | 'done';
    dueDate: string | null;
  }>;
}

interface GoalEvalResponse {
  goalAchieved: boolean;
  note: string | null;
}

function RunRetroButton({ sprintId }: { sprintId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-brand/5 px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/10 transition"
        title="Open the retrospective modal for this sprint"
      >
        <Sparkles className="h-3 w-3" />
        Run retro
      </button>
      {open && <RetroModal sprintId={sprintId} onClose={() => setOpen(false)} />}
    </>
  );
}

function RetroModal({
  sprintId,
  onClose,
}: {
  sprintId: string;
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const retroQuery = useQuery({
    queryKey: ['sprint-retro', sprintId],
    queryFn: () => api.get<RetroResponse | null>(`/sprints/${sprintId}/retro`),
  });
  const goalQuery = useQuery({
    queryKey: ['sprint-goal-eval', sprintId],
    queryFn: () => api.get<GoalEvalResponse | null>(`/sprints/${sprintId}/goal-evaluation`),
  });

  const [wentWell, setWentWell] = useState('');
  const [couldImprove, setCouldImprove] = useState('');
  const [actionItems, setActionItems] = useState<RetroResponse['actionItems']>([]);
  const [goalAchieved, setGoalAchieved] = useState<boolean | null>(null);
  const [goalNote, setGoalNote] = useState('');

  useEffect(() => {
    if (retroQuery.data) {
      setWentWell(retroQuery.data.whatWentWell ?? '');
      setCouldImprove(retroQuery.data.whatCouldImprove ?? '');
      setActionItems(retroQuery.data.actionItems ?? []);
    }
  }, [retroQuery.data]);
  useEffect(() => {
    if (goalQuery.data) {
      setGoalAchieved(goalQuery.data.goalAchieved);
      setGoalNote(goalQuery.data.note ?? '');
    }
  }, [goalQuery.data]);

  const saveRetro = useMutation({
    mutationFn: () => api.post(`/sprints/${sprintId}/retro`, {
      whatWentWell: wentWell || null,
      whatCouldImprove: couldImprove || null,
      actionItems: actionItems.map((a) => ({
        id: a.id || crypto.randomUUID(),
        description: a.description,
        ownerUserId: a.ownerUserId,
        status: a.status,
        dueDate: a.dueDate,
      })),
    }),
    onSuccess: async () => {
      // Goal eval is a separate row; save it alongside if the user picked
      // a value. Skipping when null means "don't change my goal eval" so a
      // future re-open doesn't clobber a prior eval.
      if (goalAchieved !== null) {
        await api.post(`/sprints/${sprintId}/goal-evaluation`, {
          goalAchieved,
          note: goalNote || null,
        });
      }
      toast.success('Retro saved');
      void queryClient.invalidateQueries({ queryKey: ['sprint-retro', sprintId] });
      void queryClient.invalidateQueries({ queryKey: ['sprint-goal-eval', sprintId] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save retro'),
  });

  function addActionItem(): void {
    setActionItems((prev) => [
      ...prev,
      { id: crypto.randomUUID(), description: '', ownerUserId: null, status: 'open', dueDate: null },
    ]);
  }

  function updateItem(idx: number, patch: Partial<RetroResponse['actionItems'][number]>): void {
    setActionItems((prev) => prev.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  }

  function removeItem(idx: number): void {
    setActionItems((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-card rounded-lg border border-border shadow-xl max-h-[90vh] overflow-auto">
        <header className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-semibold">Sprint retrospective</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">What went well</label>
            <textarea
              value={wentWell}
              onChange={(e) => setWentWell(e.target.value)}
              rows={3}
              maxLength={5000}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="Wins, surprises, things to keep doing…"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">What could be better</label>
            <textarea
              value={couldImprove}
              onChange={(e) => setCouldImprove(e.target.value)}
              rows={3}
              maxLength={5000}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="Friction points, missed signals, what slowed us down…"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Action items</label>
            <div className="space-y-2">
              {actionItems.map((item, idx) => (
                <div key={item.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={item.status === 'done'}
                    onChange={(e) => updateItem(idx, { status: e.target.checked ? 'done' : 'open' })}
                    className="rounded border-input"
                  />
                  <input
                    type="text"
                    value={item.description}
                    onChange={(e) => updateItem(idx, { description: e.target.value })}
                    maxLength={500}
                    className={cn(
                      'flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm',
                      item.status === 'done' && 'line-through text-muted-foreground',
                    )}
                    placeholder="Time-box planning to 60 minutes…"
                  />
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    aria-label="Remove action item"
                    className="rounded-md p-1 text-muted-foreground hover:bg-accent"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addActionItem}
                className="rounded-md border border-dashed border-border w-full px-3 py-2 text-xs hover:bg-accent"
              >
                <Plus className="h-3 w-3 inline-block mr-1" /> Add action item
              </button>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background/30 p-3 space-y-2">
            <div className="text-xs font-medium">Did we hit the sprint goal?</div>
            <div className="flex items-center gap-2">
              {([
                { v: true, label: 'Yes' },
                { v: false, label: 'No' },
              ] as const).map((opt) => (
                <button
                  key={String(opt.v)}
                  type="button"
                  onClick={() => setGoalAchieved(opt.v)}
                  className={cn(
                    'rounded-md px-3 py-1 text-xs border',
                    goalAchieved === opt.v
                      ? 'bg-brand/10 border-brand/40 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {opt.label}
                </button>
              ))}
              {goalAchieved !== null && (
                <button
                  type="button"
                  onClick={() => { setGoalAchieved(null); setGoalNote(''); }}
                  className="text-xs text-muted-foreground hover:text-foreground ml-1"
                >
                  Clear
                </button>
              )}
            </div>
            {goalAchieved !== null && (
              <input
                type="text"
                value={goalNote}
                onChange={(e) => setGoalNote(e.target.value)}
                maxLength={2000}
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                placeholder="Optional note (what tipped the balance?)"
              />
            )}
          </div>
        </div>
        <footer className="px-6 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => saveRetro.mutate()}
            disabled={saveRetro.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saveRetro.isPending ? 'Saving…' : 'Save retro'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// =============================================================================
// BulkMoveMenu — "Move N selected to…" dropdown.
// =============================================================================

function BulkMoveMenu({
  count,
  sprints,
  onMove,
  onClear,
}: {
  count: number;
  sprints: Sprint[];
  onMove: (to: ContainerId) => void;
  onClear: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition"
      >
        Move {count} selected
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="fixed inset-0 z-30 cursor-default bg-transparent" />
          <div className="absolute right-0 top-full z-40 mt-1 w-56 rounded-lg border border-border bg-popover shadow-xl">
            <header className="border-b border-border px-3 py-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Move to…
            </header>
            <ul className="max-h-60 overflow-y-auto py-1">
              {sprints.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => { onMove(s.id); setOpen(false); }}
                    className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted/60 flex items-center gap-2"
                  >
                    <Target className={cn('h-3.5 w-3.5', s.state === 'active' ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="truncate">{s.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground capitalize">{s.state}</span>
                  </button>
                </li>
              ))}
              <li className="border-t border-border mt-1 pt-1">
                <button
                  type="button"
                  onClick={() => { onMove('backlog'); setOpen(false); }}
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted/60 flex items-center gap-2"
                >
                  <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                  Backlog
                </button>
              </li>
            </ul>
            <footer className="border-t border-border p-1">
              <button
                type="button"
                onClick={() => { onClear(); setOpen(false); }}
                className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/60 rounded"
              >
                Clear selection
              </button>
            </footer>
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// SprintStatePill — small colored chip for the section header.
// =============================================================================

function SprintStatePill({ state }: { state: Sprint['state'] }): JSX.Element {
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
// Sprints-disabled empty state — one-click enable from this page.
// =============================================================================

function SprintsDisabledState({ projectId, projectName }: { projectId: string; projectName: string }): JSX.Element {
  const queryClient = useQueryClient();
  const enable = useMutation({
    mutationFn: () => api.patch(`/projects/${projectId}`, { sprintsEnabled: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Sprints enabled');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not enable sprints')),
  });
  return (
    <div className="p-12 max-w-xl mx-auto text-center space-y-3">
      <Target className="h-8 w-8 text-muted-foreground mx-auto" />
      <h2 className="text-lg font-semibold">Sprints aren't on for {projectName}</h2>
      <p className="text-sm text-muted-foreground">
        Turn sprints on to start planning. You can keep using the board and list view alongside.
      </p>
      <button
        type="button"
        onClick={() => enable.mutate()}
        disabled={enable.isPending}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition disabled:opacity-50"
      >
        {enable.isPending ? 'Enabling…' : 'Enable sprints'}
      </button>
    </div>
  );
}

// =============================================================================
// Hooks & helpers
// =============================================================================

function useSprintTasks(sprintId: string, projectId: string): { sprintId: string; data: PlannerTask[] | undefined } {
  // useQuery in a child position — same call shape every render, so the lint
  // rule about "hooks in loops" is satisfied as long as the sprint list is
  // stable. We accept that adding/removing sprints triggers a remount of
  // this hook chain, which is fine in practice.
  const q = useQuery({
    queryKey: ['sprint-tasks', sprintId],
    queryFn: () => api.get<PlannerTask[]>(`/sprints/${sprintId}/tasks`),
    enabled: Boolean(sprintId && projectId),
  });
  return { sprintId, data: q.data };
}

function applyFilters(
  tasks: PlannerTask[],
  search: string,
  assigneeFilter: string,
  priorityFilter: Priority | ''
): PlannerTask[] {
  const q = search.trim().toLowerCase();
  return tasks.filter((t) => {
    if (assigneeFilter && t.assignee?.id !== assigneeFilter) return false;
    if (priorityFilter && t.priority !== priorityFilter) return false;
    if (q) {
      const hay = `${t.key} ${t.title}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function toggleSelected(setSel: React.Dispatch<React.SetStateAction<Set<string>>>, id: string): void {
  setSel((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
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
      {isActive && <span className="truncate max-w-[120px]">{current?.label}</span>}
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

// =============================================================================
// CreateSprintDialog — modal for adding a new sprint to this project. Mirrors
// the one that used to live on the standalone Sprints page so the affordance
// is in the same place the sprints are listed.
// =============================================================================

function CreateSprintDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [goal, setGoal] = useState('');

  const createMutation = useMutation({
    mutationFn: (body: { name: string; startDate?: string; endDate?: string; goal?: string }) =>
      api.post<Sprint>(`/projects/${projectId}/sprints`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
      toast.success('Sprint created');
      onClose();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not create sprint')),
  });

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    if (!name.trim()) return;
    const body: { name: string; startDate?: string; endDate?: string; goal?: string } = { name: name.trim() };
    if (startDate) body.startDate = new Date(startDate).toISOString();
    if (endDate) body.endDate = new Date(endDate).toISOString();
    if (goal.trim()) body.goal = goal.trim();
    createMutation.mutate(body);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">New sprint</h2>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">Name</label>
            <input
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sprint 12"
              maxLength={120}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="nockta-eyebrow text-muted-foreground mb-1 block">Start</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="nockta-eyebrow text-muted-foreground mb-1 block">End</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">
              Goal / theme
              <span className="ml-1 normal-case text-muted-foreground/60">(optional)</span>
            </label>
            <input
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What's the north star for this sprint?"
              maxLength={200}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-[10px] text-muted-foreground mt-1 tabular-nums">
              {goal.length}/200
            </p>
          </div>
        </div>
        <div className="px-6 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || createMutation.isPending}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {createMutation.isPending ? 'Creating…' : 'Create sprint'}
          </button>
        </div>
      </form>
    </div>
  );
}

// =============================================================================
// CapacityChip — per-sprint scope-vs-baseline indicator. Renders neutrally
// when scope fits, and switches to a yellow warning when scope exceeds 110%
// of historical velocity. Wider thresholds were considered (e.g. tone bands
// at 80/100/120%) but a single boundary keeps the visual noise low for the
// common-case "fits comfortably" sprint.
// =============================================================================

function CapacityChip({ points, baseline }: { points: number; baseline: number }): JSX.Element {
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

// =============================================================================
// PlanWithAiDialog — opens when the user clicks "Plan with AI" on a planned
// sprint. Asks the API for:
//   1. A capacity recommendation (from analytics velocity history).
//   2. A ranked task list that fits inside that capacity.
//
// User flow:
//   - Capacity slider, defaults to the AI-recommended number.
//   - Table of ranked backlog tasks with per-row accept toggles. Default ALL
//     ranked tasks are accepted.
//   - "Move to sprint" button POSTs each accepted task into the target sprint.
// =============================================================================

interface CapacityResponse {
  suggestedPoints: number;
  lowerBound: number;
  upperBound: number;
  mean: number;
  stddev: number;
  sampleSize: number;
  explanation: string;
}

interface RankedTaskResponse {
  taskId: string;
  key: string;
  title: string;
  priority: string;
  storyPoints: number;
  ageDays: number;
  score: number;
  why: string;
}

interface PlanResponse {
  tasks: RankedTaskResponse[];
  usedPoints: number;
  capacity: number;
}

function PlanWithAiDialog({
  projectId,
  sprint,
  onClose,
  onAccepted,
}: {
  projectId: string;
  sprint: Sprint;
  onClose: () => void;
  onAccepted: () => void;
}): JSX.Element {
  // Capacity recommendation — read-only velocity math, no LLM hop.
  const capacityQuery = useQuery<CapacityResponse>({
    queryKey: ['ai-sprint-capacity', projectId],
    queryFn: () => api.get<CapacityResponse>(`/ai/projects/${projectId}/sprint-capacity`),
  });

  const [capacity, setCapacity] = useState<number | null>(null);
  // Once the capacity recommendation arrives, seed the slider with it. We
  // keep the local state so the user can tweak before fetching the ranked list.
  useEffect(() => {
    if (capacity == null && capacityQuery.data) {
      setCapacity(capacityQuery.data.suggestedPoints);
    }
  }, [capacityQuery.data, capacity]);

  // Ranked tasks — only fires once we have a concrete capacity. The endpoint
  // computes the greedy fill in-process; the response shape is what we render.
  const planQuery = useQuery<PlanResponse>({
    queryKey: ['ai-plan-sprint', projectId, capacity],
    enabled: capacity != null && capacity > 0,
    queryFn: () =>
      api.post<PlanResponse>(`/ai/projects/${projectId}/plan-sprint`, { capacity }),
  });

  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (planQuery.data) {
      // Default all ranked tasks to accepted — the PM can untick individual
      // rows but the common case is "yes, let's do this".
      setAccepted(new Set(planQuery.data.tasks.map((t) => t.taskId)));
    }
  }, [planQuery.data]);

  const moveMutation = useMutation({
    mutationFn: async (taskIds: string[]) => {
      // Move each accepted task into the sprint. We hit the existing
      // /tasks/:id PATCH endpoint per task — fine for the small N typical of
      // a sprint plan (<30 tasks).
      await Promise.all(
        taskIds.map((id) =>
          api.patch(`/tasks/${id}`, { sprintId: sprint.id }),
        ),
      );
    },
    onSuccess: () => {
      toast.success(`Moved ${accepted.size} task${accepted.size === 1 ? '' : 's'} to ${sprint.name}`);
      onAccepted();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not apply AI plan')),
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-lg border border-border bg-card shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand" />
          <h2 className="text-lg font-semibold">Plan with AI · {sprint.name}</h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-6 py-4 space-y-4 overflow-y-auto">
          {/* Capacity row */}
          {capacityQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Computing capacity from history…</div>
          ) : capacityQuery.data ? (
            <div className="rounded-md border border-border bg-background/40 p-3">
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <div className="text-sm font-semibold">Capacity</div>
                <div className="text-[10px] text-muted-foreground">
                  Range {capacityQuery.data.lowerBound}–{capacityQuery.data.upperBound} pts ·
                  sample {capacityQuery.data.sampleSize} sprint{capacityQuery.data.sampleSize === 1 ? '' : 's'}
                </div>
              </div>
              <input
                type="range"
                min={1}
                max={Math.max(capacityQuery.data.upperBound, capacityQuery.data.suggestedPoints) * 2}
                value={capacity ?? capacityQuery.data.suggestedPoints}
                onChange={(e) => setCapacity(Number(e.target.value))}
                className="w-full accent-brand"
              />
              <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                <span className="font-mono text-foreground">{capacity ?? capacityQuery.data.suggestedPoints} pts</span>
                <span>·</span>
                <span>{capacityQuery.data.explanation}</span>
              </div>
            </div>
          ) : null}

          {/* Ranked list */}
          {planQuery.isLoading && (
            <div className="text-sm text-muted-foreground">Ranking backlog…</div>
          )}
          {planQuery.data && (
            <div className="rounded-md border border-border">
              <div className="flex items-baseline justify-between px-3 py-2 border-b border-border bg-background/40">
                <div className="text-xs text-muted-foreground">
                  AI suggests {planQuery.data.tasks.length} tasks ·
                  fills {planQuery.data.usedPoints}/{planQuery.data.capacity} pts
                </div>
                <div className="text-[10px] text-muted-foreground font-mono">
                  {accepted.size} accepted
                </div>
              </div>
              {planQuery.data.tasks.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No backlog tasks fit this capacity. Estimate more tasks or raise the cap.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {planQuery.data.tasks.map((t) => {
                    const isAccepted = accepted.has(t.taskId);
                    return (
                      <li
                        key={t.taskId}
                        className={cn(
                          'flex items-center gap-3 px-3 py-2 text-sm',
                          !isAccepted && 'opacity-50',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={isAccepted}
                          onChange={(e) => {
                            setAccepted((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(t.taskId);
                              else next.delete(t.taskId);
                              return next;
                            });
                          }}
                          className="h-3.5 w-3.5 accent-brand"
                        />
                        <PriorityDot priority={t.priority as Priority} />
                        <span className="font-mono text-[10px] text-muted-foreground">{t.key}</span>
                        <span className="flex-1 truncate">{t.title}</span>
                        <span className="text-[10px] font-mono text-muted-foreground">{t.storyPoints} pts</span>
                        <span
                          className="text-[10px] text-muted-foreground hidden md:inline"
                          title={`Score ${t.score} · ${t.ageDays}d old`}
                        >
                          {t.why}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        <footer className="px-6 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={accepted.size === 0 || moveMutation.isPending}
            onClick={() => moveMutation.mutate(Array.from(accepted))}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {moveMutation.isPending ? 'Moving…' : `Move ${accepted.size} to sprint`}
          </button>
        </footer>
      </div>
    </div>
  );
}

// =============================================================================
// SprintGoalRow — inline goal/theme editor surfaced under every sprint section.
// Active sprints render the goal prominently (so the team has a north-star
// sentence in front of them all day); planned and completed sprints show a
// subtler version. Click to edit; managers and contributors can persist.
// =============================================================================

function SprintGoalRow({
  sprintId,
  projectId,
  goal,
  state,
}: {
  sprintId: string;
  projectId: string;
  goal: string | null;
  state: Sprint['state'];
}): JSX.Element {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal ?? '');
  useEffect(() => {
    setDraft(goal ?? '');
  }, [goal]);

  const save = useMutation({
    mutationFn: (next: string | null) =>
      api.patch<Sprint>(`/sprints/${sprintId}`, { goal: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
      toast.success(state === 'active' ? 'Goal updated' : 'Goal saved');
      setEditing(false);
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not save goal')),
  });

  // Active sprints get a more visible, slightly accented banner; everything
  // else gets a quiet inline row. The visual hierarchy mirrors which sprint
  // the team should be paying attention to right now.
  const accentForActive = state === 'active';

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = draft.trim();
          save.mutate(trimmed.length > 0 ? trimmed : null);
        }}
        className={cn(
          'flex items-center gap-2 rounded-md border px-2 py-1.5',
          accentForActive
            ? 'border-primary/40 bg-primary/5'
            : 'border-border/60 bg-card/30',
        )}
      >
        <Target className={cn('h-3 w-3 shrink-0', accentForActive ? 'text-primary' : 'text-muted-foreground')} />
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={200}
          placeholder={state === 'active' ? "What's this sprint's north star?" : 'Add a sprint goal…'}
          className="flex-1 bg-transparent text-xs focus:outline-none placeholder:text-muted-foreground"
        />
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {draft.length}/200
        </span>
        <button
          type="submit"
          disabled={save.isPending || draft.trim() === (goal ?? '')}
          className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(goal ?? '');
            setEditing(false);
          }}
          className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </form>
    );
  }

  if (!goal) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          'flex items-center gap-2 rounded-md border border-dashed px-2 py-1.5 w-full text-left transition-colors',
          accentForActive
            ? 'border-primary/30 hover:bg-primary/5'
            : 'border-border/40 hover:bg-card/30',
        )}
      >
        <Target className="h-3 w-3 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">
          {state === 'active' ? 'Set a sprint goal' : 'Add a sprint goal'}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn(
        'flex items-center gap-2 rounded-md border px-2 py-1.5 w-full text-left transition-colors',
        accentForActive
          ? 'border-primary/40 bg-primary/5 hover:bg-primary/10'
          : 'border-border/60 hover:bg-card/40',
      )}
      title="Click to edit"
    >
      <Target className={cn('h-3 w-3 shrink-0', accentForActive ? 'text-primary' : 'text-muted-foreground')} />
      <span
        className={cn(
          'text-xs flex-1 truncate',
          accentForActive ? 'font-medium text-foreground' : 'text-foreground/80',
        )}
      >
        {goal}
      </span>
    </button>
  );
}

// =============================================================================
// SprintAiSummary — LLM-generated recap for active/completed sprints. Rendered
// in a collapsed <details> inside the sprint section so it doesn't take up
// space until the user wants it.
// =============================================================================

function SprintAiSummary({ sprintId }: { sprintId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const summaryQuery = useQuery({
    queryKey: ['sprint-summary', sprintId],
    queryFn: () =>
      api.get<{ summary: string | null; generatedAt: string | null }>(
        `/ai/sprints/${sprintId}/summary`,
      ),
  });
  const generate = useMutation({
    mutationFn: () =>
      api.post<{ summary: string; generatedAt: string }>(
        `/ai/sprints/${sprintId}/summarize-now`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprint-summary', sprintId] });
      toast.success('Summary generated');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not generate summary')),
  });

  const summary = summaryQuery.data?.summary;
  const generatedAt = summaryQuery.data?.generatedAt;

  return (
    <details className="rounded-md border border-border/60 bg-card/30">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground flex items-center gap-2">
        <Sparkles className="h-3 w-3 text-primary" />
        AI sprint summary
        {generatedAt && (
          <span className="ml-1 text-[10px] text-muted-foreground/70">
            · {new Date(generatedAt).toLocaleString()}
          </span>
        )}
      </summary>
      <div className="border-t border-border/60 px-3 py-2 text-xs">
        {!summary && !generate.isPending && (
          <button
            type="button"
            onClick={() => generate.mutate()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/20 transition"
          >
            <Sparkles className="h-3 w-3" />
            Generate summary
          </button>
        )}
        {generate.isPending && (
          <p className="text-[11px] text-muted-foreground">Thinking… this can take 10–20 seconds.</p>
        )}
        {summary && !generate.isPending && (
          <>
            <div className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
              {summary}
            </div>
            <button
              type="button"
              onClick={() => generate.mutate()}
              className="mt-2 text-[10px] text-muted-foreground hover:text-foreground"
            >
              Regenerate
            </button>
          </>
        )}
      </div>
    </details>
  );
}

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.problem.detail) return err.problem.detail;
    if (err.problem.title) return err.problem.title;
  }
  return fallback;
}
