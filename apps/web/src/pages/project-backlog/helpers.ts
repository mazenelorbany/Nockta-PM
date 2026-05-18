import { useQueries } from '@tanstack/react-query';
import { ApiError } from '@nockta/sdk';

import { api } from '../../lib/api';
import type { Priority } from '../../components/task-bits';

import type { PlannerTask } from './types';

/**
 * Fetch the tasks for every supplied sprint in parallel. Uses TanStack's
 * `useQueries` because the number of sprints is variable across renders
 * (toggling "show completed", an Admin archiving a sprint, etc.) and a
 * `.map(useSprintTasks)` would violate the rules of hooks.
 *
 * The return shape keeps the legacy `{ sprintId, data }` per-row contract
 * so existing callers don't need to change.
 */
export function useSprintTasksList(
  sprintIds: string[],
  projectId: string,
): Array<{ sprintId: string; data: PlannerTask[] | undefined }> {
  const results = useQueries({
    queries: sprintIds.map((sprintId) => ({
      queryKey: ['sprint-tasks', sprintId] as const,
      queryFn: () => api.get<PlannerTask[]>(`/sprints/${sprintId}/tasks`),
      enabled: Boolean(sprintId && projectId),
    })),
  });
  return sprintIds.map((sprintId, idx) => ({
    sprintId,
    data: results[idx]?.data,
  }));
}

export function applyFilters(
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

export function toggleSelected(setSel: React.Dispatch<React.SetStateAction<Set<string>>>, id: string): void {
  setSel((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.problem.detail) return err.problem.detail;
    if (err.problem.title) return err.problem.title;
  }
  return fallback;
}
