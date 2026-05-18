import type { TaskType } from '../task-bits';

import type { TaskFilters } from './types';

// =============================================================================
// Filter helper — apply a TaskFilters to a raw task list. Shared between Board
// and List view so they behave identically.
//
// Special-case: filters.assigneeUserId === 'unassigned' matches tasks with no
// assignee, mirroring the picker's "Unassigned" row.
// =============================================================================

interface FilterableTask {
  id: string;
  key: string;
  title: string;
  status: string;
  type?: TaskType;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  isBlocked: boolean;
  assignee?: { id: string; name: string } | null | undefined;
  sprintId?: string | null;
  /** Required for the projectIds filter to do anything. Single-project boards
   *  can omit it; the filter is then a no-op (everything matches). */
  projectId?: string;
  /** Required for the labelIds filter. Accepts either the API's nested shape
   *  (`{ label: { id, ... } }[]` from the TaskLabel join) or the flat shape. */
  labels?:
    | Array<{ label: { id: string } } | { id: string }>
    | null
    | undefined;
  customFieldValues?: Array<{ fieldId: string; value: unknown }>;
}

export function applyTaskFilters<T extends FilterableTask>(
  tasks: T[],
  filters: TaskFilters,
): T[] {
  const search = filters.search.trim().toLowerCase();
  const cfEntries = Object.entries(filters.customFields ?? {}).filter(([, v]) => v);
  const projectIdSet =
    filters.projectIds && filters.projectIds.length > 0
      ? new Set(filters.projectIds)
      : null;
  const labelIdSet =
    filters.labelIds && filters.labelIds.length > 0
      ? new Set(filters.labelIds)
      : null;
  return tasks.filter((t) => {
    if (projectIdSet && t.projectId && !projectIdSet.has(t.projectId)) return false;
    if (labelIdSet) {
      // OR semantics — task matches if ANY of its labels is in the selected set.
      // No labels on the task ⇒ excluded.
      const taskLabelIds = (t.labels ?? []).map((row) =>
        'label' in row ? row.label.id : row.id,
      );
      if (!taskLabelIds.some((id) => labelIdSet.has(id))) return false;
    }
    if (filters.assigneeUserId) {
      if (filters.assigneeUserId === 'unassigned') {
        if (t.assignee) return false;
      } else if (t.assignee?.id !== filters.assigneeUserId) {
        return false;
      }
    }
    if (filters.priority && t.priority !== filters.priority) return false;
    if (filters.type && (t.type ?? 'Task') !== filters.type) return false;
    if (filters.blocked && !t.isBlocked) return false;
    if (filters.hideDone && t.status.toLowerCase() === 'done') return false;
    if (filters.sprintId) {
      if (filters.sprintId === 'backlog') {
        if (t.sprintId) return false;
      } else if (t.sprintId !== filters.sprintId) {
        return false;
      }
    }
    if (cfEntries.length > 0) {
      const values = t.customFieldValues ?? [];
      for (const [fieldId, wanted] of cfEntries) {
        const row = values.find((v) => v.fieldId === fieldId);
        if (!row) return false;
        if (Array.isArray(row.value)) {
          if (!(row.value as unknown[]).includes(wanted)) return false;
        } else if (String(row.value) !== wanted) {
          return false;
        }
      }
    }
    if (search) {
      const hay = `${t.key} ${t.title}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}
