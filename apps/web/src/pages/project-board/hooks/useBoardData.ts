import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { applyTaskFilters, type BoardView, type TaskFilters } from '../../../components/board-toolbar';
import { api } from '../../../lib/api';
import { PRESET_STATUSES } from '../constants';
import type { ActiveSprint, Project, Task } from '../types';
import { queryKeys } from '../../../lib/query-keys';

// Server-driven workflow snapshot. Drives the board's column list so admins
// can add a custom status from Project Settings → Workflow and see it appear
// as a new lane on the next paint, without restarting the app.
interface WorkflowSnapshot {
  columns: Array<{ id: string; name: string; position: number }>;
  statuses: Array<{
    id: string;
    columnId: string;
    name: string;
    position: number;
    isInitialStatus: boolean;
    isDoneStatus: boolean;
  }>;
}

export interface UseBoardDataResult {
  projectQuery: UseQueryResult<Project>;
  tasksQuery: UseQueryResult<Task[]>;
  sprintsQuery: UseQueryResult<ActiveSprint[]>;
  savedViewsQuery: UseQueryResult<
    { id: string; name: string; query: { projectId?: string; filters: TaskFilters; view: BoardView } }[]
  >;
  tasks: Task[];
  project: Project | undefined;
  activeSprint: ActiveSprint | null;
  columns: string[];
  visibleTasks: Task[];
  byStatus: Map<string, Task[]>;
  subtasksByParent: Map<string, Task[]>;
}

export function useBoardData({
  projectId,
  filters,
  savedViewParam,
}: {
  projectId: string | undefined;
  filters: TaskFilters;
  savedViewParam: string | null;
}): UseBoardDataResult {
  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const tasksQuery = useQuery({
    queryKey: queryKeys.projectTasks(projectId),
    queryFn: () => api.get<Task[]>(`/tasks/project/${projectId}`),
    enabled: Boolean(projectId),
  });
  const sprintsQuery = useQuery({
    queryKey: queryKeys.sprints(projectId),
    queryFn: () => api.get<ActiveSprint[]>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId && projectQuery.data?.sprintsEnabled),
  });
  const savedViewsQuery = useQuery({
    queryKey: queryKeys.savedViews(),
    queryFn: () =>
      api.get<{ id: string; name: string; query: { projectId?: string; filters: TaskFilters; view: BoardView } }[]>('/saved-views'),
    enabled: Boolean(savedViewParam),
    staleTime: 30_000,
  });
  const workflowQuery = useQuery({
    queryKey: ['project-workflow', projectId],
    queryFn: () => api.get<WorkflowSnapshot>(`/projects/${projectId}/workflow`),
    enabled: Boolean(projectId),
  });

  const activeSprint = (sprintsQuery.data ?? []).find((s) => s.state === 'active') ?? null;
  const tasks = tasksQuery.data ?? [];
  const project = projectQuery.data;

  // Columns on the board are the project's ProjectStatus names, ordered by
  // (column.position, status.position) so the visual order tracks what the
  // Workflow settings editor shows. Falls back to the preset constant
  // during the brief window before the workflow query resolves so the board
  // doesn't render a blank canvas on first paint.
  const columns = useMemo(() => {
    const snap = workflowQuery.data;
    if (!snap || snap.statuses.length === 0) {
      return project ? PRESET_STATUSES[project.workflowPreset] : [];
    }
    const colPos = new Map(snap.columns.map((c) => [c.id, c.position]));
    return [...snap.statuses]
      .sort((a, b) => {
        const ca = colPos.get(a.columnId) ?? 0;
        const cb = colPos.get(b.columnId) ?? 0;
        if (ca !== cb) return ca - cb;
        return a.position - b.position;
      })
      .map((s) => s.name);
  }, [workflowQuery.data, project]);
  const visibleTasks = useMemo(() => applyTaskFilters(tasks, filters), [tasks, filters]);
  // Children (anything with a parentTaskId — subtasks, stories under epics,
  // tasks under stories) live inside their parent card. Keep them OUT of the
  // column grouping so the board doesn't show a parent and its children side
  // by side. If the user has explicitly filtered to type=Subtask, surface them
  // (otherwise that filter would render an empty board).
  const showChildrenAsCards = filters.type === 'Subtask';
  const byStatus = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const c of columns) m.set(c, []);
    for (const t of visibleTasks) {
      if (!showChildrenAsCards && t.parentTaskId) continue;
      m.get(t.status)?.push(t);
    }
    return m;
  }, [visibleTasks, columns, showChildrenAsCards]);
  // Group every task by its parent so each card can render its subtasks inline.
  // Computed off the unfiltered task list so collapsing under filters still
  // shows the full subtask roster on each card.
  const subtasksByParent = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!t.parentTaskId) continue;
      const arr = m.get(t.parentTaskId) ?? [];
      arr.push(t);
      m.set(t.parentTaskId, arr);
    }
    return m;
  }, [tasks]);

  return {
    projectQuery,
    tasksQuery,
    sprintsQuery,
    savedViewsQuery,
    tasks,
    project,
    activeSprint,
    columns,
    visibleTasks,
    byStatus,
    subtasksByParent,
  };
}
