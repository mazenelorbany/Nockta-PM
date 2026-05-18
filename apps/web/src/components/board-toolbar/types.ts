import type { Priority, TaskType } from '../task-bits';

export type BoardView = 'board' | 'list';

export interface TaskFilters {
  // Optionals are allowed to be explicitly set to undefined so toolbar handlers
  // can clear a single key with `setFilters({ ...filters, key: undefined })`
  // under exactOptionalPropertyTypes.
  assigneeUserId?: string | undefined;
  priority?: 'Low' | 'Medium' | 'High' | 'Critical' | undefined;
  type?: TaskType | undefined;
  blocked?: boolean | undefined;
  hideDone: boolean;
  search: string;
  /** Sprint filter: undefined = no filter, 'backlog' = no sprint, sprintId = that sprint. */
  sprintId?: string | 'backlog' | undefined;
  /** Custom-field filter: { [fieldId]: value }. Empty by default. */
  customFields?: Record<string, string> | undefined;
  /** Cross-project filter: empty/undefined = no filter (show all projects the
   *  caller passed in), populated = only these project ids. Only meaningful
   *  on workspace-scope boards (e.g. /board, dashboards) where the toolbar
   *  is rendered without a single `projectId` prop. */
  projectIds?: string[] | undefined;
  /** Multi-label filter — empty/undefined = no filter, populated = tasks must
   *  carry at least one of these label ids (OR semantics, ClickUp-style).
   *  Label rows are derived from the loaded task list, same pattern as the
   *  Assignee filter, so we never show a label that has no tasks here. */
  labelIds?: string[] | undefined;
}

export const EMPTY_FILTERS: TaskFilters = {
  hideDone: false,
  search: '',
};

export interface ToolbarUser {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string | null;
}

export interface Sprint {
  id: string;
  name: string;
  state: 'planned' | 'active' | 'completed';
}

export interface SavedView {
  id: string;
  name: string;
  /** Saved views are JSON-typed on the backend; we shape them as a board
   *  configuration. `projectId` is the legacy single-scope; `projectIds` lives
   *  inside `filters` and lets a saved view span multiple projects. */
  query: { projectId?: string; filters: TaskFilters; view: BoardView };
}

/**
 * A project the toolbar can offer in the multi-project filter. The page that
 * mounts the toolbar provides this list — for workspace-scope boards it's
 * every project the user can see; for single-project boards it's omitted.
 */
export interface ToolbarProject {
  id: string;
  key: string;
  name: string;
}

/**
 * Minimal shape of a task we need to derive the eligible-assignee and
 * eligible-label lists, and the task counts. Callers pass their own task
 * list (already loaded by the page) so the toolbar doesn't need to refetch.
 *
 * Label rows live on tasks via the TaskLabel join — the API hydrates them as
 * `labels: [{ label: { id, name, color } }]`. We accept either that or the
 * already-flattened `labels: [{ id, name, color }]` shape so the page can
 * pass whichever it has.
 */
export interface ToolbarTask {
  assignee?: { id: string; name: string; avatarUrl?: string | null } | null | undefined;
  labels?:
    | Array<{ label: { id: string; name: string; color: string } }>
    | Array<{ id: string; name: string; color: string }>
    | null
    | undefined;
}

export interface ToolbarLabel {
  id: string;
  name: string;
  color: string;
  count: number;
}

export interface CustomFieldDef {
  id: string;
  name: string;
  kind: 'text' | 'number' | 'select' | 'multiselect' | 'date' | 'url' | 'checkbox';
  options: { value: string; label: string }[];
}

/** Resolve either shape into a flat label list. Tolerant of nulls. */
export function flattenLabels(
  raw: ToolbarTask['labels'],
): Array<{ id: string; name: string; color: string }> {
  if (!raw) return [];
  const out: Array<{ id: string; name: string; color: string }> = [];
  for (const row of raw) {
    if (row && 'label' in row && row.label) out.push(row.label);
    else if (row && 'id' in row) out.push(row);
  }
  return out;
}

export const PRIORITIES: Priority[] = ['Critical', 'High', 'Medium', 'Low'];

export const TYPES: TaskType[] = ['Epic', 'Story', 'Task', 'Bug', 'Subtask'];
