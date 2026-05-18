import { useQuery } from '@tanstack/react-query';
import { LayoutGrid, List as ListIcon, X } from 'lucide-react';
import { useMemo } from 'react';
import { api } from '../lib/api';
import { AssigneeFilter } from './board-toolbar/AssigneeFilter';
import { CustomFieldFilters } from './board-toolbar/CustomFieldFilters';
import { ToggleChip } from './board-toolbar/FilterChip';
import { LabelsFilter } from './board-toolbar/LabelsFilter';
import { PriorityFilter } from './board-toolbar/PriorityFilter';
import { ProjectsFilter } from './board-toolbar/ProjectsFilter';
import { SavedViewsMenu } from './board-toolbar/SavedViewsMenu';
import { SearchInput } from './board-toolbar/SearchInput';
import { SprintFilter } from './board-toolbar/SprintFilter';
import {
  EMPTY_FILTERS,
  flattenLabels,
  type BoardView,
  type Sprint,
  type TaskFilters,
  type ToolbarLabel,
  type ToolbarProject,
  type ToolbarTask,
  type ToolbarUser,
} from './board-toolbar/types';
import { TypeFilter } from './board-toolbar/TypeFilter';
import { ViewTab } from './board-toolbar/ViewTab';

// =============================================================================
// Toolbar that sits above the board/list views. ClickUp-style: view tabs on
// the left, filter chips + group/sort on the right.
//
// Filter chips are portaled popovers (not native <select>) so they render with
// avatars, type glyphs, priority dots, and proper hover/keyboard affordances.
// The Assignee picker only shows people who actually have a task in this
// project — the previous native select fetched every user in the workspace.
// =============================================================================

// Re-export public API so external imports from './board-toolbar' keep working.
export { applyTaskFilters } from './board-toolbar/applyTaskFilters';
export { EMPTY_FILTERS } from './board-toolbar/types';
export type {
  BoardView,
  TaskFilters,
  ToolbarProject,
  ToolbarTask,
} from './board-toolbar/types';

export function BoardToolbar({
  view,
  onViewChange,
  filters,
  onFiltersChange,
  taskCount,
  projectId,
  sprintsEnabled,
  tasks = [],
  availableProjects,
}: {
  view: BoardView;
  onViewChange: (v: BoardView) => void;
  filters: TaskFilters;
  onFiltersChange: (f: TaskFilters) => void;
  taskCount: number;
  projectId?: string;
  sprintsEnabled?: boolean;
  /** All loaded tasks for the current project. Used to derive the assignee
   *  picker so we only show people who actually have work here. */
  tasks?: ToolbarTask[];
  /** When set (e.g. on /board), the toolbar renders a multi-select Projects
   *  filter chip backed by filters.projectIds. Omit for single-project boards. */
  availableProjects?: ToolbarProject[];
}): JSX.Element {
  // Derive eligible assignees from the loaded task list — this guarantees we
  // never show a person who has zero tasks in this project. Each user gets a
  // task count, sorted by count desc then name asc.
  const eligibleAssignees = useMemo<Array<ToolbarUser & { count: number }>>(() => {
    const map = new Map<string, ToolbarUser & { count: number }>();
    for (const t of tasks) {
      const a = t.assignee;
      if (!a) continue;
      const existing = map.get(a.id);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(a.id, {
          id: a.id,
          name: a.name,
          avatarUrl: a.avatarUrl ?? null,
          count: 1,
        });
      }
    }
    return Array.from(map.values()).sort((x, y) => {
      if (y.count !== x.count) return y.count - x.count;
      return x.name.localeCompare(y.name);
    });
  }, [tasks]);

  const unassignedCount = useMemo(
    () => tasks.reduce((n, t) => (t.assignee ? n : n + 1), 0),
    [tasks],
  );

  // Derive eligible labels the same way we derive eligible assignees — walk
  // the loaded tasks, dedupe, count usage, sort by usage desc.
  const eligibleLabels = useMemo<ToolbarLabel[]>(() => {
    const map = new Map<string, ToolbarLabel>();
    for (const t of tasks) {
      for (const l of flattenLabels(t.labels)) {
        const existing = map.get(l.id);
        if (existing) {
          existing.count += 1;
        } else {
          map.set(l.id, { id: l.id, name: l.name, color: l.color, count: 1 });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
  }, [tasks]);

  const sprintsQuery = useQuery({
    queryKey: ['sprints', projectId],
    queryFn: () => api.get<Sprint[]>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId && sprintsEnabled),
  });
  const sprints = sprintsQuery.data ?? [];

  const activeFilterCount =
    (filters.assigneeUserId ? 1 : 0) +
    (filters.priority ? 1 : 0) +
    (filters.type ? 1 : 0) +
    (filters.blocked ? 1 : 0) +
    (filters.hideDone ? 1 : 0) +
    (filters.search ? 1 : 0) +
    (filters.sprintId ? 1 : 0) +
    (filters.projectIds && filters.projectIds.length > 0 ? 1 : 0) +
    (filters.labelIds && filters.labelIds.length > 0 ? 1 : 0) +
    Object.values(filters.customFields ?? {}).filter(Boolean).length;

  const selectedAssignee = filters.assigneeUserId
    ? eligibleAssignees.find((u) => u.id === filters.assigneeUserId)
    : null;
  const selectedSprint = filters.sprintId && filters.sprintId !== 'backlog'
    ? sprints.find((s) => s.id === filters.sprintId)
    : null;

  return (
    <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap md:static sticky top-0 z-30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {/* View tabs */}
      <div className="flex items-center gap-1 rounded-md bg-secondary/60 p-1">
        <ViewTab active={view === 'board'} onClick={() => onViewChange('board')} icon={<LayoutGrid className="h-3.5 w-3.5" />} label="Board" />
        <ViewTab active={view === 'list'} onClick={() => onViewChange('list')} icon={<ListIcon className="h-3.5 w-3.5" />} label="List" />
      </div>

      {/* Filter chips */}
      <div className="flex items-center gap-2 flex-1 justify-end flex-wrap">
        <SavedViewsMenu
          projectId={projectId}
          currentFilters={filters}
          currentView={view}
          onApply={(saved) => {
            if (saved.query.filters) onFiltersChange(saved.query.filters);
            if (saved.query.view) onViewChange(saved.query.view);
          }}
        />
        <SearchInput
          value={filters.search}
          onChange={(v) => onFiltersChange({ ...filters, search: v })}
        />

        {/* PROJECTS — multi-select, only on workspace-scope boards. */}
        {availableProjects && availableProjects.length > 0 && (
          <ProjectsFilter
            value={filters.projectIds ?? []}
            projects={availableProjects}
            onChange={(ids) =>
              onFiltersChange({
                ...filters,
                projectIds: ids.length > 0 ? ids : undefined,
              })
            }
          />
        )}

        {/* ASSIGNEE — modern popover with avatars, derived from project tasks. */}
        <AssigneeFilter
          value={filters.assigneeUserId}
          users={eligibleAssignees}
          unassignedCount={unassignedCount}
          selectedUser={selectedAssignee ?? null}
          onChange={(v) => onFiltersChange({ ...filters, assigneeUserId: v })}
        />

        {/* PRIORITY — colored dots */}
        <PriorityFilter
          value={filters.priority}
          onChange={(p) => onFiltersChange({ ...filters, priority: p })}
        />

        {/* TYPE — Jira-style glyphs */}
        <TypeFilter
          value={filters.type}
          onChange={(t) => onFiltersChange({ ...filters, type: t })}
        />

        {/* LABEL — multi-select chip, only renders when the board has labels in
            play. Empty list is hidden so it doesn't take up space when unused. */}
        {eligibleLabels.length > 0 && (
          <LabelsFilter
            value={filters.labelIds ?? []}
            labels={eligibleLabels}
            onChange={(ids) =>
              onFiltersChange({
                ...filters,
                labelIds: ids.length > 0 ? ids : undefined,
              })
            }
          />
        )}

        {sprintsEnabled && (
          <SprintFilter
            value={filters.sprintId}
            sprints={sprints}
            selectedSprint={selectedSprint ?? null}
            onChange={(s) => onFiltersChange({ ...filters, sprintId: s })}
          />
        )}

        {projectId && (
          <CustomFieldFilters
            projectId={projectId}
            value={filters.customFields ?? {}}
            onChange={(customFields) => onFiltersChange({ ...filters, customFields })}
          />
        )}

        <ToggleChip
          active={filters.blocked ?? false}
          onClick={() => onFiltersChange({ ...filters, blocked: filters.blocked ? undefined : true })}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-status-blocked" /> Blocked
        </ToggleChip>

        <ToggleChip
          active={filters.hideDone}
          onClick={() => onFiltersChange({ ...filters, hideDone: !filters.hideDone })}
        >
          Hide done
        </ToggleChip>

        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={() => onFiltersChange(EMPTY_FILTERS)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            <X className="h-3 w-3" /> Clear ({activeFilterCount})
          </button>
        )}

        <span className="nockta-eyebrow text-muted-foreground ml-2">
          {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
        </span>
      </div>
    </div>
  );
}
