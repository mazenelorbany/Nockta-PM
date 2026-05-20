import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Inbox, Target } from 'lucide-react';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useParams } from 'react-router-dom';

import type { Priority } from '../components/task-bits';
import { api } from '../lib/api';
import { useResolvedProject } from '../lib/project-route';
import { queryKeys } from '../lib/query-keys';

import { Pane } from './sprint-planning/Pane';
import { TaskRow } from './sprint-planning/TaskRow';
import { SprintCapacityBar } from './sprint-planning/SprintCapacityBar';
import { PlannerHeader } from './sprint-planning/PlannerHeader';
import { PlannerToolbar } from './sprint-planning/PlannerToolbar';
import { applyFilters, apiErrorMessage, toggleSelected } from './sprint-planning/helpers';
import type { PlannerTask, Project, Side, Sprint } from './sprint-planning/types';

// =============================================================================
// /projects/:projectId/sprints/:sprintId/plan
// ClickUp-style sprint planner: Backlog on the left, Sprint on the right.
// Drag tasks between panes, or click a single task to move it. The page shows
// live capacity (count + sum-of-estimates + per-assignee load) so a planner
// can size the sprint as they go.
// =============================================================================

export function SprintPlanningPage(): JSX.Element {
  // Sprint id keeps using useParams (still a UUID). Project resolution goes
  // through the slug-aware hook so `/projects/ACME/sprints/<sprintId>/plan`
  // works alongside legacy UUID URLs.
  const { sprintId = '' } = useParams<{ sprintId: string }>();
  const { projectId } = useResolvedProject();
  const queryClient = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const sprintsQuery = useQuery({
    queryKey: queryKeys.sprints(projectId),
    queryFn: () => api.get<Sprint[]>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId),
  });
  const backlogQuery = useQuery({
    queryKey: ['backlog', projectId],
    queryFn: () => api.get<PlannerTask[]>(`/projects/${projectId}/backlog`),
    enabled: Boolean(projectId),
  });
  const sprintTasksQuery = useQuery({
    queryKey: ['sprint-tasks', sprintId],
    queryFn: () => api.get<PlannerTask[]>(`/sprints/${sprintId}/tasks`),
    enabled: Boolean(sprintId),
  });

  const project = projectQuery.data;
  const sprint = (sprintsQuery.data ?? []).find((s) => s.id === sprintId) ?? null;
  const backlog = useMemo(() => backlogQuery.data ?? [], [backlogQuery.data]);
  const sprintTasks = useMemo(() => sprintTasksQuery.data ?? [], [sprintTasksQuery.data]);

  // Filter state — applied to BOTH panes so the planner can focus by assignee
  // or label without losing visibility of what's already in the sprint.
  const [search, setSearch] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('');
  const [priorityFilter, setPriorityFilter] = useState<Priority | ''>('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const invalidateBoth = () => {
    void queryClient.invalidateQueries({ queryKey: ['backlog', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['sprint-tasks', sprintId] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
  };

  const addToSprint = useMutation({
    mutationFn: (taskIds: string[]) =>
      api.post(`/sprints/${sprintId}/tasks`, { taskIds }),
    onSuccess: (_, taskIds) => {
      toast.success(`${taskIds.length} ${taskIds.length === 1 ? 'task' : 'tasks'} → ${sprint?.name ?? 'sprint'}`);
      invalidateBoth();
      setSelected(new Set());
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not add to sprint')),
  });
  const removeFromSprint = useMutation({
    mutationFn: (taskId: string) => api.delete(`/sprints/${sprintId}/tasks/${taskId}`),
    onSuccess: () => {
      invalidateBoth();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not remove from sprint')),
  });
  const startSprint = useMutation({
    mutationFn: () => api.post(`/sprints/${sprintId}/start`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sprints(projectId) });
      toast.success('Sprint started');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not start sprint')),
  });

  // ---------- Filtering ----------
  const filteredBacklog = useMemo(
    () => applyFilters(backlog, search, assigneeFilter, priorityFilter),
    [backlog, search, assigneeFilter, priorityFilter]
  );
  const filteredSprint = useMemo(
    () => applyFilters(sprintTasks, search, assigneeFilter, priorityFilter),
    [sprintTasks, search, assigneeFilter, priorityFilter]
  );

  // ---------- Capacity ----------
  const capacity = useMemo(() => {
    const points = sprintTasks.reduce((acc, t) => acc + (t.estimate ?? 0), 0);
    const byAssignee = new Map<string, { name: string; avatarUrl?: string | null; count: number; points: number }>();
    let unassignedCount = 0;
    let unassignedPoints = 0;
    for (const t of sprintTasks) {
      if (!t.assignee) {
        unassignedCount += 1;
        unassignedPoints += t.estimate ?? 0;
        continue;
      }
      const cur = byAssignee.get(t.assignee.id) ?? {
        name: t.assignee.name,
        avatarUrl: (t.assignee.avatarUrl ?? null) as string | null,
        count: 0,
        points: 0,
      };
      cur.count += 1;
      cur.points += t.estimate ?? 0;
      byAssignee.set(t.assignee.id, cur);
    }
    return {
      count: sprintTasks.length,
      points,
      byAssignee: Array.from(byAssignee.entries()).map(([id, v]) => ({ id, ...v })),
      unassignedCount,
      unassignedPoints,
    };
  }, [sprintTasks]);

  // Unique assignees across both lists for the filter dropdown.
  const assigneeOptions = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const t of [...backlog, ...sprintTasks]) {
      if (t.assignee) m.set(t.assignee.id, { id: t.assignee.id, name: t.assignee.name });
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [backlog, sprintTasks]);

  // ---------- Drag-and-drop ----------
  const [dragging, setDragging] = useState<{ id: string; from: Side } | null>(null);
  function onDragStart(e: DragStartEvent): void {
    const data = e.active.data.current as { from: Side } | undefined;
    if (data) setDragging({ id: e.active.id as string, from: data.from });
  }
  function onDragEnd(e: DragEndEvent): void {
    setDragging(null);
    const overId = e.over?.id;
    const data = e.active.data.current as { from: Side } | undefined;
    if (!overId || !data) return;
    const targetSide: Side = overId === 'pane-sprint' ? 'sprint' : 'backlog';
    if (data.from === targetSide) return;
    if (targetSide === 'sprint') {
      addToSprint.mutate([e.active.id as string]);
    } else {
      removeFromSprint.mutate(e.active.id as string);
    }
  }

  if (!project) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!sprint) {
    return (
      <div className="p-8 space-y-3">
        <p className="text-sm text-muted-foreground">Sprint not found.</p>
        <Link to={`/projects/${projectId}/backlog`} className="text-xs text-primary hover:underline">
          ← Back to backlog
        </Link>
      </div>
    );
  }

  const canModify = sprint.state !== 'completed';

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex flex-col h-full">
        <PlannerHeader
          project={project}
          sprint={sprint}
          projectId={projectId}
          sprintId={sprintId}
          canModify={canModify}
          sprintTasksCount={sprintTasks.length}
          startSprintPending={startSprint.isPending}
          onStartSprint={() => startSprint.mutate()}
        />

        <PlannerToolbar
          search={search}
          setSearch={setSearch}
          assigneeFilter={assigneeFilter}
          setAssigneeFilter={setAssigneeFilter}
          priorityFilter={priorityFilter}
          setPriorityFilter={setPriorityFilter}
          assigneeOptions={assigneeOptions}
          selectedCount={selected.size}
          onAddSelected={() => addToSprint.mutate(Array.from(selected))}
          addPending={addToSprint.isPending}
        />

        {/* Two-pane planner */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_1fr] divide-y lg:divide-y-0 lg:divide-x divide-border overflow-hidden">
          {/* Backlog pane */}
          <Pane
            id="pane-backlog"
            title="Backlog"
            icon={<Inbox className="h-3.5 w-3.5 text-muted-foreground" />}
            count={filteredBacklog.length}
            empty="No tasks in the backlog. Create one from the board, then come back here to plan."
            highlight={dragging?.from === 'sprint'}
            onCreateHref={`/projects/${projectId}/board`}
          >
            {filteredBacklog.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                side="backlog"
                isSelected={selected.has(t.id)}
                {...(canModify
                  ? {
                      onToggleSelect: () => toggleSelected(setSelected, t.id),
                      onPrimary: () => addToSprint.mutate([t.id]),
                    }
                  : {})}
                primaryIcon={<ArrowRight className="h-3 w-3" />}
                primaryLabel="Add to sprint"
              />
            ))}
          </Pane>

          {/* Sprint pane */}
          <Pane
            id="pane-sprint"
            title={sprint.name}
            icon={<Target className="h-3.5 w-3.5 text-primary" />}
            count={filteredSprint.length}
            empty="No tasks in this sprint yet. Drag from the backlog, or click → next to any task."
            highlight={dragging?.from === 'backlog'}
            summary={
              <SprintCapacityBar
                count={capacity.count}
                points={capacity.points}
                unassignedCount={capacity.unassignedCount}
                unassignedPoints={capacity.unassignedPoints}
                byAssignee={capacity.byAssignee}
              />
            }
          >
            {filteredSprint.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                side="sprint"
                {...(canModify
                  ? { onPrimary: () => removeFromSprint.mutate(t.id) }
                  : {})}
                primaryIcon={<ArrowLeft className="h-3 w-3" />}
                primaryLabel="Remove from sprint"
              />
            ))}
          </Pane>
        </div>
      </div>
    </DndContext>
  );
}
