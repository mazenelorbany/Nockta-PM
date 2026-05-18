import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';
import { applyTaskFilters, type BoardView, type TaskFilters } from '../../../components/board-toolbar';
import { api } from '../../../lib/api';
import { PRESET_STATUSES } from '../constants';
import type { ActiveSprint, Project, Task } from '../types';

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
    queryKey: ['project', projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const tasksQuery = useQuery({
    queryKey: ['tasks', 'project', projectId],
    queryFn: () => api.get<Task[]>(`/tasks/project/${projectId}`),
    enabled: Boolean(projectId),
  });
  const sprintsQuery = useQuery({
    queryKey: ['sprints', projectId],
    queryFn: () => api.get<ActiveSprint[]>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId && projectQuery.data?.sprintsEnabled),
  });
  const savedViewsQuery = useQuery({
    queryKey: ['saved-views'],
    queryFn: () =>
      api.get<{ id: string; name: string; query: { projectId?: string; filters: TaskFilters; view: BoardView } }[]>('/saved-views'),
    enabled: Boolean(savedViewParam),
    staleTime: 30_000,
  });

  const activeSprint = (sprintsQuery.data ?? []).find((s) => s.state === 'active') ?? null;
  const tasks = tasksQuery.data ?? [];
  const project = projectQuery.data;

  const columns = useMemo(() => (project ? PRESET_STATUSES[project.workflowPreset] : []), [project]);
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
