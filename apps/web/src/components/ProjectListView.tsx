import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ApiError } from '@nockta/sdk';
import { cn } from '@nockta/ui';

import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

import { applyTaskFilters, type TaskFilters } from './board-toolbar';
import {
  AvatarCircle,
  BlockedBadge,
  DueDateChip,
  PriorityDot,
  StatusPill,
  TypeBadge,
  type Priority,
  type TaskType,
} from './task-bits';

// =============================================================================
// ClickUp-style List view. Tasks grouped by status, each group collapsible.
// Every cell is inline-editable: click a status pill to open a status menu,
// click priority dot to cycle, click assignee to reassign, etc.
// =============================================================================

interface Task {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  dueDate?: string | null;
  estimate?: number | null;
  parentTaskId?: string | null;
  assignee?: { id: string; name: string; avatarUrl?: string };
}

interface Project {
  id: string;
  key: string;
  name: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
}

interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

interface UserListResponse {
  items: User[];
  nextCursor: string | null;
}

const PRESET_STATUSES: Record<Project['workflowPreset'], string[]> = {
  engineering: ['Todo', 'In Progress', 'In Review', 'Testing', 'Done'],
  design:      ['Todo', 'In Progress', 'In Review', 'Approved', 'Done'],
  generic:     ['Todo', 'In Progress', 'Done'],
};

interface WorkflowSnapshot {
  columns: Array<{ id: string; name: string; position: number }>;
  statuses: Array<{ id: string; columnId: string; name: string; position: number }>;
}

export function ProjectListView({
  project,
  tasks,
  filters,
  onOpenTask,
  onAddTask,
  selectedIds,
  onToggleSelect,
}: {
  project: Project;
  tasks: Task[];
  filters: TaskFilters;
  onOpenTask: (id: string) => void;
  onAddTask: (status: string) => void;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
}): JSX.Element {
  // Custom statuses + columns ship via /projects/:id/workflow. Fall back to
  // the preset constant during the loading window so the table doesn't
  // disappear on first paint.
  const workflowQuery = useQuery({
    queryKey: ['project-workflow', project.id],
    queryFn: () => api.get<WorkflowSnapshot>(`/projects/${project.id}/workflow`),
  });
  const columns = useMemo(() => {
    const snap = workflowQuery.data;
    if (!snap || snap.statuses.length === 0) return PRESET_STATUSES[project.workflowPreset];
    const colPos = new Map(snap.columns.map((c) => [c.id, c.position]));
    return [...snap.statuses]
      .sort((a, b) => {
        const ca = colPos.get(a.columnId) ?? 0;
        const cb = colPos.get(b.columnId) ?? 0;
        if (ca !== cb) return ca - cb;
        return a.position - b.position;
      })
      .map((s) => s.name);
  }, [workflowQuery.data, project.workflowPreset]);
  const filtered = useMemo(() => applyTaskFilters(tasks, filters), [tasks, filters]);

  // Build the parent/child index off the FILTERED set so the hierarchy
  // respects whatever filter chip the user has on.
  const childrenByParent = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of filtered) {
      if (!t.parentTaskId) continue;
      const arr = m.get(t.parentTaskId) ?? [];
      arr.push(t);
      m.set(t.parentTaskId, arr);
    }
    return m;
  }, [filtered]);

  // Top-level grouping: by Epic. Walk each task's ancestor chain (using the
  // FULL task list, so we can resolve parents that the filter has hidden) and
  // bucket the task under the first Epic we hit. Tasks with no Epic ancestor
  // fall into the synthetic "No Epic" group at the bottom.
  const taskById = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  // Memoised so the parent useMemo's deps array stays stable across renders.
  // The closure only touches `taskById`, so the only invalidation reason is
  // a fresh task map — which is itself memoised above.
  const findEpicAncestor = useCallback(
    (t: Task): string | null => {
      let cur: Task | undefined = t;
      const seen = new Set<string>();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (cur.type === 'Epic') return cur.id;
        cur = cur.parentTaskId ? taskById.get(cur.parentTaskId) : undefined;
      }
      return null;
    },
    [taskById],
  );

  const groups = useMemo(() => {
    // epicId → list of top-level rows under that Epic. "Top level under Epic"
    // means the row's direct parent in the *visible* set is the Epic itself
    // (or it has no visible parent at all). Children of those rows render
    // recursively via TaskHierarchyNode below.
    const visibleIds = new Set(filtered.map((t) => t.id));
    const byEpic = new Map<string | null, Task[]>();
    const epicRows = new Map<string, Task>();

    for (const t of filtered) {
      // Epics themselves are headers; they don't appear inside a group's body.
      if (t.type === 'Epic') {
        epicRows.set(t.id, t);
        continue;
      }
      // Skip any row whose parent is also visible AND non-Epic — it'll be
      // rendered recursively inside that parent's expand body, not at the
      // group's top level.
      if (t.parentTaskId && visibleIds.has(t.parentTaskId)) {
        const parent = taskById.get(t.parentTaskId);
        if (parent && parent.type !== 'Epic') continue;
      }
      const epicId = findEpicAncestor(t);
      const key = epicId ?? null;
      const arr = byEpic.get(key) ?? [];
      arr.push(t);
      byEpic.set(key, arr);
    }

    // Surface every Epic in the filtered set even if it has no children yet,
    // so the user can see/expand it.
    for (const [id] of epicRows) {
      if (!byEpic.has(id)) byEpic.set(id, []);
    }

    // Order: every Epic (sorted by numeric key suffix so "EPIC-2" comes before
    // "EPIC-10"), then "No Epic" last.
    const epicEntries = Array.from(epicRows.values()).sort((a, b) => {
      const an = parseInt(a.key.split('-').pop() ?? '0', 10);
      const bn = parseInt(b.key.split('-').pop() ?? '0', 10);
      return an - bn;
    });
    const noEpicChildren = byEpic.get(null) ?? [];
    return { epics: epicEntries, byEpic, noEpicChildren };
  }, [filtered, taskById, findEpicAncestor]);

  // Parents (Epics + non-Epic rows with subtasks) start collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  function toggleParent(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalRows = groups.epics.length + groups.noEpicChildren.length;

  return (
    <div className="px-8 py-6">
      <div className="rounded-lg border border-border overflow-hidden">
        {/* Header row — extra leading column for the expand chevron */}
        <div className="grid grid-cols-[24px_24px_1.5fr_120px_60px_140px_120px_60px] gap-3 px-3 py-2 bg-secondary/40 border-b border-border text-xs nockta-eyebrow text-muted-foreground">
          <span />
          <span />
          <span>Name</span>
          <span>Status</span>
          <span className="text-center">Priority</span>
          <span>Assignee</span>
          <span>Due</span>
          <span className="text-center">Est.</span>
        </div>

        {totalRows === 0 && (
          <div className="px-4 py-6 text-xs text-muted-foreground">
            No tasks match the current filters.
          </div>
        )}

        {/* One section per Epic. Each Epic is a header row that expands to
            reveal its child rows (Stories/Tasks/Bugs), which themselves expand
            to reveal their Subtasks via TaskHierarchyNode. */}
        {groups.epics.map((epic) => {
          const children = groups.byEpic.get(epic.id) ?? [];
          const isOpen = expanded.has(epic.id);
          return (
            <div key={epic.id}>
              <TaskRow
                task={epic}
                project={project}
                columns={columns}
                depth={0}
                hasChildren={children.length > 0}
                childrenOpen={isOpen}
                onToggleChildren={
                  children.length > 0 ? () => toggleParent(epic.id) : undefined
                }
                onOpen={() => onOpenTask(epic.id)}
                selected={selectedIds?.has(epic.id) ?? false}
                onToggleSelect={onToggleSelect ? () => onToggleSelect(epic.id) : undefined}
                rightLabel={`${children.length} item${children.length === 1 ? '' : 's'}`}
              />
              {isOpen && children.map((c) => (
                <TaskHierarchyNode
                  key={c.id}
                  task={c}
                  project={project}
                  columns={columns}
                  depth={1}
                  childrenByParent={childrenByParent}
                  expanded={expanded}
                  onToggleParent={toggleParent}
                  onOpen={onOpenTask}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                />
              ))}
            </div>
          );
        })}

        {/* "No Epic" bucket — orphan Stories/Tasks/Bugs/Subtasks that don't roll
            up to an Epic. Always last; hidden when empty. */}
        {groups.noEpicChildren.length > 0 && (
          <NoEpicGroup
            children_={groups.noEpicChildren}
            project={project}
            columns={columns}
            childrenByParent={childrenByParent}
            expanded={expanded}
            onToggleParent={toggleParent}
            onOpen={onOpenTask}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
          />
        )}

        {/* Footer add-button — adds to the default "Todo" column. */}
        <button
          type="button"
          onClick={() => onAddTask(columns[0] ?? 'Todo')}
          className="w-full grid grid-cols-[24px_24px_1fr] items-center px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors text-left"
        >
          <span />
          <Plus className="h-3.5 w-3.5" />
          <span>Add task</span>
        </button>
      </div>
    </div>
  );
}

// Synthetic group for tasks without an Epic ancestor — renders a header row
// with a chevron, then its children when expanded.
function NoEpicGroup({
  children_,
  project,
  columns,
  childrenByParent,
  expanded,
  onToggleParent,
  onOpen,
  selectedIds,
  onToggleSelect,
}: {
  children_: Task[];
  project: Project;
  columns: string[];
  childrenByParent: Map<string, Task[]>;
  expanded: Set<string>;
  onToggleParent: (id: string) => void;
  onOpen: (id: string) => void;
  selectedIds: Set<string> | undefined;
  onToggleSelect: ((id: string) => void) | undefined;
}): JSX.Element {
  // Use a sentinel id so this group's open/closed state lives in the same set
  // as Epic ids without colliding (no real task has this id).
  const HEADER_ID = '__no-epic__';
  const isOpen = expanded.has(HEADER_ID);
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleParent(HEADER_ID)}
        aria-expanded={isOpen}
        className="w-full grid grid-cols-[24px_24px_1fr] gap-3 items-center px-3 py-2 bg-card/40 border-b border-border hover:bg-card/70 transition-colors text-left"
      >
        <span />
        <ChevronRight
          className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ease-out"
          style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <span className="flex items-center gap-2 text-xs text-muted-foreground nockta-eyebrow">
          No Epic
          <span className="text-[10px] text-muted-foreground/60">{children_.length}</span>
        </span>
      </button>
      {isOpen && children_.map((c) => (
        <TaskHierarchyNode
          key={c.id}
          task={c}
          project={project}
          columns={columns}
          depth={1}
          childrenByParent={childrenByParent}
          expanded={expanded}
          onToggleParent={onToggleParent}
          onOpen={onOpen}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </div>
  );
}

// Recursive renderer — emits the row, then if expanded its children below it
// at depth+1. Cycle protection isn't needed: parentTaskId references are
// validated on create/update at the API layer.
function TaskHierarchyNode({
  task,
  project,
  columns,
  depth,
  childrenByParent,
  expanded,
  onToggleParent,
  onOpen,
  selectedIds,
  onToggleSelect,
}: {
  task: Task;
  project: Project;
  columns: string[];
  depth: number;
  childrenByParent: Map<string, Task[]>;
  expanded: Set<string>;
  onToggleParent: (id: string) => void;
  onOpen: (id: string) => void;
  selectedIds: Set<string> | undefined;
  onToggleSelect: ((id: string) => void) | undefined;
}): JSX.Element {
  const children = childrenByParent.get(task.id) ?? [];
  const hasChildren = children.length > 0;
  const isOpen = expanded.has(task.id);
  return (
    <>
      <TaskRow
        task={task}
        project={project}
        columns={columns}
        depth={depth}
        hasChildren={hasChildren}
        childrenOpen={isOpen}
        onToggleChildren={hasChildren ? () => onToggleParent(task.id) : undefined}
        onOpen={() => onOpen(task.id)}
        selected={selectedIds?.has(task.id) ?? false}
        onToggleSelect={onToggleSelect ? () => onToggleSelect(task.id) : undefined}
      />
      {isOpen && children.map((c) => (
        <TaskHierarchyNode
          key={c.id}
          task={c}
          project={project}
          columns={columns}
          depth={depth + 1}
          childrenByParent={childrenByParent}
          expanded={expanded}
          onToggleParent={onToggleParent}
          onOpen={onOpen}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </>
  );
}

// =============================================================================
// Individual row — every cell is inline-editable.
// =============================================================================

function TaskRow({
  task,
  project,
  columns,
  depth = 0,
  hasChildren = false,
  childrenOpen = false,
  onToggleChildren,
  onOpen,
  selected,
  onToggleSelect,
  rightLabel,
}: {
  task: Task;
  project: Project;
  columns: string[];
  depth?: number;
  hasChildren?: boolean;
  childrenOpen?: boolean;
  onToggleChildren: (() => void) | undefined;
  onOpen: () => void;
  selected: boolean;
  onToggleSelect: (() => void) | undefined;
  /** Optional right-side annotation, e.g. "5 items" on Epic header rows. */
  rightLabel?: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(project.id) });

  const usersQuery = useQuery({
    queryKey: queryKeys.usersList(),
    queryFn: () => api.get<UserListResponse>('/users?limit=100'),
  });

  const patch = useMutation({
    mutationFn: (body: Partial<{ priority: Priority; assigneeUserId: string | null }>) =>
      api.patch(`/tasks/${task.id}`, body),
    onSuccess: invalidate,
    onError: (err) => {
      const detail =
        err instanceof ApiError ? err.problem.title || err.message : 'Update failed';
      toast.error(detail);
    },
  });

  const statusMutation = useMutation({
    mutationFn: (status: string) => api.patch(`/tasks/${task.id}/status`, { status }),
    onSuccess: invalidate,
    onError: (err) => {
      const detail =
        err instanceof ApiError ? err.problem.title || err.message : 'Status change failed';
      toast.error(detail);
    },
  });

  return (
    <div
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      className={cn(
        'cv-row grid grid-cols-[24px_24px_1.5fr_120px_60px_140px_120px_60px] gap-3 items-center px-3 py-2 border-b border-border last:border-b-0 hover:bg-accent/30 transition-colors cursor-pointer group',
        selected && 'bg-primary/10 hover:bg-primary/15'
      )}
    >
      {/* Checkbox (shown on hover or when selected) */}
      {onToggleSelect ? (
        <input
          type="checkbox"
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
          className={cn(
            'h-3.5 w-3.5 cursor-pointer',
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          aria-label={`Select ${task.key}`}
        />
      ) : (
        <span className="text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity text-xs">⋮⋮</span>
      )}

      {/* Expand chevron — only for parents. Empty cell otherwise so the grid
          aligns across rows of mixed depth. */}
      {hasChildren ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleChildren?.();
          }}
          aria-expanded={childrenOpen}
          aria-label={childrenOpen ? 'Collapse subtasks' : 'Expand subtasks'}
          className="tap inline-flex items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <ChevronRight
            className="h-3.5 w-3.5 transition-transform duration-200 ease-out"
            style={{ transform: childrenOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
        </button>
      ) : (
        <span />
      )}

      {/* Type + title + key + blocked badge — indent by depth. The left padding
          comes from depth so the row still occupies one grid cell. */}
      <div
        className="flex items-center gap-2 min-w-0"
        style={depth > 0 ? { paddingLeft: depth * 16 } : undefined}
      >
        {depth > 0 && (
          <span
            className="shrink-0 text-muted-foreground/40 text-xs"
            aria-hidden="true"
          >
            └
          </span>
        )}
        <TypeBadge type={task.type ?? 'Task'} />
        <span className="text-[11px] font-mono text-muted-foreground shrink-0">{task.key}</span>
        <span className="text-sm font-medium truncate">{task.title}</span>
        <BlockedBadge blocked={task.isBlocked} />
        {rightLabel && (
          <span className="ml-auto text-[10px] text-muted-foreground/70 nockta-eyebrow shrink-0">
            {rightLabel}
          </span>
        )}
      </div>

      {/* Status — inline editable */}
      <InlineSelect
        value={task.status}
        options={columns}
        onChange={(v) => statusMutation.mutate(v)}
        render={(v) => <StatusPill status={v} />}
      />

      {/* Priority — click to cycle */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          const order: Priority[] = ['Low', 'Medium', 'High', 'Critical'];
          const next = order[(order.indexOf(task.priority) + 1) % order.length]!;
          patch.mutate({ priority: next });
        }}
        className="flex items-center justify-center transition-transform duration-150 ease-out hover:scale-110 active:scale-95"
        title={`Priority: ${task.priority} — click to cycle`}
      >
        <PriorityDot priority={task.priority} />
      </button>

      {/* Assignee — inline editable */}
      <InlineSelect
        value={task.assignee?.id ?? ''}
        options={['', ...(usersQuery.data?.items ?? []).map((u) => u.id)]}
        labelFor={(id) => {
          if (!id) return 'Unassigned';
          const u = usersQuery.data?.items.find((x) => x.id === id);
          return u?.name || u?.email || '(unknown)';
        }}
        onChange={(v) =>
          patch.mutate({ assigneeUserId: v === '' ? null : v })
        }
        render={() =>
          task.assignee ? (
            <span className="flex items-center gap-1.5 min-w-0">
              <AvatarCircle user={task.assignee} size={20} />
              <span className="text-xs truncate">{task.assignee.name}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <AvatarCircle user={null} size={20} />
              <span className="text-xs">Unassigned</span>
            </span>
          )
        }
      />

      {/* Due date */}
      <span>
        <DueDateChip dueDate={task.dueDate} done={task.status === 'Done'} />
      </span>

      {/* Estimate */}
      <span className="text-xs text-muted-foreground text-center">
        {task.estimate ?? '—'}
      </span>
    </div>
  );
}

/**
 * Tiny inline-edit select — wraps a hidden <select> in a styled label so it
 * looks like a display chip until clicked.
 */
function InlineSelect({
  value,
  options,
  onChange,
  render,
  labelFor,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  render: (v: string) => React.ReactNode;
  labelFor?: (v: string) => string;
}): JSX.Element {
  return (
    <label
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'relative inline-flex items-center rounded-md transition-colors cursor-pointer min-w-0',
        'hover:bg-accent/60 px-1 -mx-1 py-0.5',
      )}
    >
      {render(value)}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {labelFor ? labelFor(o) : o || '—'}
          </option>
        ))}
      </select>
    </label>
  );
}
