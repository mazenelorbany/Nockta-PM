import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@nockta/sdk';
import { api } from '../../lib/api';
import type { PlannerTask } from './types';
import type { Priority } from '../../components/task-bits';

export function useSprintTasks(sprintId: string, projectId: string): { sprintId: string; data: PlannerTask[] | undefined } {
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
