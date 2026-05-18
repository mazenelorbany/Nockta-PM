import { ApiError } from '@nockta/sdk';

import type { Priority } from '../../components/task-bits';

import type { PlannerTask } from './types';

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

export function toggleSelected(
  setSel: React.Dispatch<React.SetStateAction<Set<string>>>,
  id: string,
): void {
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
