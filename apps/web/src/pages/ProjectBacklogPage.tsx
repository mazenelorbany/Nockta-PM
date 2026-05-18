import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Inbox,
  Plus,
  Search,
  Target,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { cn, QueryErrorState, Spinner } from '@nockta/ui';
import { ProjectTabs } from '../components/ProjectTabs';
import { TaskDetailDrawer } from '../components/TaskDetailDrawer';
import { PullIndicator, usePullToRefresh } from '../hooks/usePullToRefresh';
import { type Priority } from '../components/task-bits';
import { api } from '../lib/api';
import { BulkMoveMenu } from './project-backlog/BulkMoveMenu';
import { CreateSprintDialog } from './project-backlog/CreateSprintDialog';
import { Pill } from './project-backlog/Pill';
import { PlanWithAiDialog } from './project-backlog/PlanWithAiDialog';
import { Section } from './project-backlog/Section';
import { SprintAiSummary } from './project-backlog/SprintAiSummary';
import { SprintGoalRow } from './project-backlog/SprintGoalRow';
import { SprintHeaderActions } from './project-backlog/SprintHeaderActions';
import { SprintsDisabledState } from './project-backlog/SprintsDisabledState';
import {
  apiErrorMessage,
  applyFilters,
  toggleSelected,
  useSprintTasks,
} from './project-backlog/helpers';
import type {
  ContainerId,
  PlannerTask,
  Project,
  Sprint,
} from './project-backlog/types';

// =============================================================================
// /projects/:projectId/backlog
// Jira/ClickUp-style backlog manager: every planned sprint + the active sprint
// + the backlog, all on one page. Drag tasks between any of them. The backlog
// section is always at the bottom and never collapses by default so you can
// always see what's waiting.
// =============================================================================

export function ProjectBacklogPage(): JSX.Element {
  const { projectId = '' } = useParams<{ projectId: string }>();
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
              {'Backlog & sprints'}
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
