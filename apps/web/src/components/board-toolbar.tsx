import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bookmark,
  BookmarkPlus,
  Check,
  ChevronDown,
  LayoutGrid,
  List as ListIcon,
  Trash2,
  X,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';
import { api } from '../lib/api';
import { AvatarCircle, PriorityDot, TypeBadge, type Priority, type TaskType } from './task-bits';

// =============================================================================
// Toolbar that sits above the board/list views. ClickUp-style: view tabs on
// the left, filter chips + group/sort on the right.
//
// Filter chips are portaled popovers (not native <select>) so they render with
// avatars, type glyphs, priority dots, and proper hover/keyboard affordances.
// The Assignee picker only shows people who actually have a task in this
// project — the previous native select fetched every user in the workspace.
// =============================================================================

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

interface ToolbarUser {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string | null;
}

interface Sprint {
  id: string;
  name: string;
  state: 'planned' | 'active' | 'completed';
}

interface SavedView {
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

interface ToolbarLabel {
  id: string;
  name: string;
  color: string;
  count: number;
}

/** Resolve either shape into a flat label list. Tolerant of nulls. */
function flattenLabels(
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

function ViewTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'tap inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-[background-color,color,transform] duration-150',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="relative">
      <svg className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search tasks…"
        className="h-7 w-56 rounded-md bg-secondary/60 pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 transition-[width,box-shadow] duration-200 ease-out focus:w-72"
      />
    </label>
  );
}

// =============================================================================
// Filter chip — the trigger button for every filter popover. Visually matches
// the old FilterSelect (border, label eyebrow, value slot) but is a real
// button so it doesn't have the cropped-native-select behavior.
// =============================================================================

function FilterChip({
  label,
  active,
  onClick,
  children,
  triggerRef,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  triggerRef?: React.RefObject<HTMLButtonElement>;
}): JSX.Element {
  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={onClick}
      className={cn(
        'tap relative inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer transition-colors',
        active
          ? 'border-brand/40 bg-accent text-foreground'
          : 'border-border bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="nockta-eyebrow text-[0.6rem] opacity-60">{label}</span>
      <span className="flex items-center gap-1.5">{children}</span>
      <ChevronDown className="h-3 w-3 opacity-50" />
    </button>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'tap inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-brand/40 bg-accent text-foreground'
          : 'border-border bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

// =============================================================================
// Portal popover — same pattern as TaskDetailDrawer's PopoverShell. Anchors
// to a passed-in trigger ref, positions below it, clamps to viewport.
// =============================================================================

function FilterPopover({
  open,
  onClose,
  triggerRef,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement>;
  children: React.ReactNode;
  className?: string;
}): JSX.Element | null {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const triggerEl = triggerRef.current;
    if (!triggerEl) return;

    function reposition(): void {
      if (!triggerEl) return;
      const rect = triggerEl.getBoundingClientRect();
      const top = rect.bottom + 6;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const popoverWidth = popoverRef.current?.offsetWidth ?? 240;
      // Align left edge with trigger by default; clamp to viewport.
      let left = rect.left;
      left = Math.max(8, Math.min(left, vw - popoverWidth - 8));
      const maxHeight = Math.max(120, vh - top - 16);
      setCoords({ top, left, maxHeight });
    }

    reposition();
    const raf = window.requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open || !coords) return null;
  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-[60] cursor-default bg-transparent"
      />
      <div
        ref={popoverRef}
        className={cn(
          'animate-popover-in fixed z-[61] min-w-[220px] rounded-lg border border-border bg-popover shadow-xl shadow-black/40 overflow-hidden',
          className,
        )}
        style={{
          top: coords.top,
          left: coords.left,
          maxHeight: coords.maxHeight,
          transformOrigin: 'top left',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

function PopoverList({ children }: { children: React.ReactNode }): JSX.Element {
  return <ul className="overflow-y-auto p-1 max-h-72 stagger-list">{children}</ul>;
}

function PopoverRow({
  selected,
  onClick,
  children,
}: {
  selected?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <li className="stagger-item">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'tap w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left',
          'hover:bg-accent/60 transition-colors duration-150',
          selected && 'bg-accent/40',
        )}
      >
        <span className="flex-1 min-w-0 flex items-center gap-2">{children}</span>
        {selected && <Check className="h-3 w-3 text-brand shrink-0" />}
      </button>
    </li>
  );
}

// =============================================================================
// Assignee filter — rich popover with avatars + per-person task count, plus
// "Unassigned" and "All" rows. Built on top of FilterPopover.
// =============================================================================

function AssigneeFilter({
  value,
  users,
  unassignedCount,
  selectedUser,
  onChange,
}: {
  value: string | undefined;
  users: Array<ToolbarUser & { count: number }>;
  unassignedCount: number;
  selectedUser: ToolbarUser | null;
  onChange: (v: string | undefined) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      `${u.name} ${u.email ?? ''}`.toLowerCase().includes(q),
    );
  }, [users, query]);

  const isActive = Boolean(value);

  return (
    <>
      <FilterChip
        label="Assignee"
        active={isActive}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {value === 'unassigned' ? (
          <span className="flex items-center gap-1.5">
            <AvatarCircle user={null} size={16} />
            <span>Unassigned</span>
          </span>
        ) : selectedUser ? (
          <span className="flex items-center gap-1.5">
            <AvatarCircle user={selectedUser} size={16} />
            <span className="truncate max-w-[110px]">{selectedUser.name}</span>
          </span>
        ) : null}
      </FilterChip>

      <FilterPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        className="w-64"
      >
        <div className="p-2 border-b border-border">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people…"
            className="w-full h-7 rounded-md bg-secondary/60 px-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
        </div>
        <PopoverList>
          <PopoverRow
            selected={!value}
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-muted/60 text-[10px] text-muted-foreground">∅</span>
            <span className="flex-1">All assignees</span>
            <span className="text-[10px] text-muted-foreground">{users.length + (unassignedCount > 0 ? 1 : 0)}</span>
          </PopoverRow>

          {unassignedCount > 0 && (
            <PopoverRow
              selected={value === 'unassigned'}
              onClick={() => {
                onChange('unassigned');
                setOpen(false);
              }}
            >
              <AvatarCircle user={null} size={20} />
              <span className="flex-1">Unassigned</span>
              <span className="text-[10px] text-muted-foreground">{unassignedCount}</span>
            </PopoverRow>
          )}

          {filtered.length === 0 && users.length > 0 && (
            <li className="px-3 py-3 text-[11px] text-muted-foreground text-center">
              No people match "{query}"
            </li>
          )}
          {users.length === 0 && (
            <li className="px-3 py-4 text-[11px] text-muted-foreground text-center leading-relaxed">
              No one is assigned to any task in this project yet.
            </li>
          )}

          {filtered.map((u) => (
            <PopoverRow
              key={u.id}
              selected={value === u.id}
              onClick={() => {
                onChange(u.id);
                setOpen(false);
              }}
            >
              <AvatarCircle user={u} size={20} />
              <span className="flex-1 truncate">{u.name}</span>
              <span className="text-[10px] text-muted-foreground">{u.count}</span>
            </PopoverRow>
          ))}
        </PopoverList>
      </FilterPopover>
    </>
  );
}

// =============================================================================
// Priority filter — colored dots + ranks. Cleaner than a four-option dropdown.
// =============================================================================

const PRIORITIES: Priority[] = ['Critical', 'High', 'Medium', 'Low'];

function PriorityFilter({
  value,
  onChange,
}: {
  value: Priority | undefined;
  onChange: (v: Priority | undefined) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <FilterChip
        label="Priority"
        active={Boolean(value)}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {value && (
          <span className="flex items-center gap-1.5">
            <PriorityDot priority={value} />
            <span>{value}</span>
          </span>
        )}
      </FilterChip>
      <FilterPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
      >
        <PopoverList>
          <PopoverRow
            selected={!value}
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            <span className="h-2 w-2 rounded-full bg-muted-foreground/40 ring-2 ring-card" />
            <span>All priorities</span>
          </PopoverRow>
          {PRIORITIES.map((p) => (
            <PopoverRow
              key={p}
              selected={value === p}
              onClick={() => {
                onChange(p);
                setOpen(false);
              }}
            >
              <PriorityDot priority={p} />
              <span>{p}</span>
            </PopoverRow>
          ))}
        </PopoverList>
      </FilterPopover>
    </>
  );
}

// =============================================================================
// Type filter — Jira-style glyphs.
// =============================================================================

const TYPES: TaskType[] = ['Epic', 'Story', 'Task', 'Bug', 'Subtask'];

function TypeFilter({
  value,
  onChange,
}: {
  value: TaskType | undefined;
  onChange: (v: TaskType | undefined) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <FilterChip
        label="Type"
        active={Boolean(value)}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {value && (
          <span className="flex items-center gap-1.5">
            <TypeBadge type={value} />
            <span>{value}</span>
          </span>
        )}
      </FilterChip>
      <FilterPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
      >
        <PopoverList>
          <PopoverRow
            selected={!value}
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            <span className="h-4 w-4 rounded bg-muted/40" />
            <span>All types</span>
          </PopoverRow>
          {TYPES.map((t) => (
            <PopoverRow
              key={t}
              selected={value === t}
              onClick={() => {
                onChange(t);
                setOpen(false);
              }}
            >
              <TypeBadge type={t} />
              <span>{t}</span>
            </PopoverRow>
          ))}
        </PopoverList>
      </FilterPopover>
    </>
  );
}

// =============================================================================
// Sprint filter.
// =============================================================================

function SprintFilter({
  value,
  sprints,
  selectedSprint,
  onChange,
}: {
  value: string | 'backlog' | undefined;
  sprints: Sprint[];
  selectedSprint: Sprint | null;
  onChange: (v: string | 'backlog' | undefined) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <FilterChip
        label="Sprint"
        active={Boolean(value)}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {value === 'backlog' ? (
          <span>Backlog</span>
        ) : selectedSprint ? (
          <span className="truncate max-w-[110px]">{selectedSprint.name}</span>
        ) : null}
      </FilterChip>
      <FilterPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
      >
        <PopoverList>
          <PopoverRow
            selected={!value}
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            <span>All sprints</span>
          </PopoverRow>
          <PopoverRow
            selected={value === 'backlog'}
            onClick={() => {
              onChange('backlog');
              setOpen(false);
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
            <span>Backlog (no sprint)</span>
          </PopoverRow>
          {sprints.map((s) => (
            <PopoverRow
              key={s.id}
              selected={value === s.id}
              onClick={() => {
                onChange(s.id);
                setOpen(false);
              }}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  s.state === 'active' && 'bg-emerald-400',
                  s.state === 'planned' && 'bg-amber-400',
                  s.state === 'completed' && 'bg-muted-foreground/40',
                )}
              />
              <span className="flex-1 truncate">{s.name}</span>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{s.state}</span>
            </PopoverRow>
          ))}
        </PopoverList>
      </FilterPopover>
    </>
  );
}

// =============================================================================
// Custom-field filters — surfaces project-defined select/multiselect/checkbox
// fields so the toolbar can narrow by anything the project defines.
// =============================================================================

interface CustomFieldDef {
  id: string;
  name: string;
  kind: 'text' | 'number' | 'select' | 'multiselect' | 'date' | 'url' | 'checkbox';
  options: { value: string; label: string }[];
}

// =============================================================================
// Projects filter — multi-select popover with project gradient badges. Backs
// filters.projectIds on workspace-scope boards (e.g. /board). Selecting more
// than one project ORs them; selecting zero means "no project filter" which
// the parent interprets as "everything the caller passed in".
// =============================================================================

function ProjectsFilter({
  value,
  projects,
  onChange,
}: {
  value: string[];
  projects: ToolbarProject[];
  onChange: (ids: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedSet = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q),
    );
  }, [projects, query]);

  // Compact summary in the chip body. Show the single project's key when only
  // one is selected; otherwise show "N projects".
  const summary = (() => {
    if (value.length === 0) return null;
    if (value.length === 1) {
      const p = projects.find((x) => x.id === value[0]);
      return p ? p.key : '1 project';
    }
    return `${value.length} projects`;
  })();

  function toggle(id: string): void {
    if (selectedSet.has(id)) {
      onChange(value.filter((x) => x !== id));
    } else {
      onChange([...value, id]);
    }
  }

  return (
    <>
      <FilterChip
        label="Project"
        active={value.length > 0}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {summary && <span className="truncate max-w-[110px]">{summary}</span>}
      </FilterChip>
      <FilterPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        className="w-72"
      >
        <div className="p-2 border-b border-border">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            className="w-full h-7 rounded-md bg-secondary/60 px-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
        </div>
        <PopoverList>
          {value.length > 0 && (
            <PopoverRow onClick={() => onChange([])}>
              <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-muted/60 text-[10px] text-muted-foreground">∅</span>
              <span className="flex-1">Clear selection</span>
            </PopoverRow>
          )}
          {filtered.length === 0 ? (
            <li className="px-3 py-3 text-[11px] text-muted-foreground text-center">
              No projects match "{query}"
            </li>
          ) : (
            filtered.map((p) => {
              const checked = selectedSet.has(p.id);
              return (
                <PopoverRow
                  key={p.id}
                  selected={checked}
                  onClick={() => toggle(p.id)}
                >
                  <ProjectBadge projectKey={p.key} size={20} />
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">{p.key}</span>
                </PopoverRow>
              );
            })
          )}
        </PopoverList>
      </FilterPopover>
    </>
  );
}

/**
 * Small inline project badge — deterministic gradient seeded by the project
 * key, mirrors the one used in the sidebar so the same project reads the same
 * everywhere in the UI.
 */
function ProjectBadge({ projectKey, size = 22 }: { projectKey: string; size?: number }): JSX.Element {
  let h = 5381;
  for (let i = 0; i < projectKey.length; i++) h = ((h << 5) + h + projectKey.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return (
    <span
      className="inline-flex items-center justify-center rounded-md font-mono font-bold tracking-tight text-white shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(135deg, hsl(${hue}, 75%, 58%), hsl(${(hue + 28) % 360}, 70%, 48%))`,
      }}
    >
      {projectKey.slice(0, 2)}
    </span>
  );
}

// =============================================================================
// Labels filter — multi-select chip backed by filters.labelIds. Each row shows
// a colored dot keyed off the label's hex color, plus its name and usage count.
// OR semantics: a task matches if it carries any selected label.
// =============================================================================

function LabelsFilter({
  value,
  labels,
  onChange,
}: {
  value: string[];
  labels: ToolbarLabel[];
  onChange: (ids: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedSet = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return labels;
    return labels.filter((l) => l.name.toLowerCase().includes(q));
  }, [labels, query]);

  // Chip body summary: single label inline, multiple → "N labels".
  const summary = (() => {
    if (value.length === 0) return null;
    if (value.length === 1) {
      const l = labels.find((x) => x.id === value[0]);
      return l ? (
        <>
          <LabelDot color={l.color} />
          <span className="truncate max-w-[110px]">{l.name}</span>
        </>
      ) : (
        <span>1 label</span>
      );
    }
    return <span>{value.length} labels</span>;
  })();

  function toggle(id: string): void {
    if (selectedSet.has(id)) {
      onChange(value.filter((x) => x !== id));
    } else {
      onChange([...value, id]);
    }
  }

  return (
    <>
      <FilterChip
        label="Label"
        active={value.length > 0}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {summary}
      </FilterChip>
      <FilterPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        className="w-64"
      >
        <div className="p-2 border-b border-border">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search labels…"
            className="w-full h-7 rounded-md bg-secondary/60 px-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
        </div>
        <PopoverList>
          {value.length > 0 && (
            <PopoverRow onClick={() => onChange([])}>
              <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-muted/60 text-[10px] text-muted-foreground">∅</span>
              <span className="flex-1">Clear selection</span>
            </PopoverRow>
          )}
          {filtered.length === 0 ? (
            <li className="px-3 py-3 text-[11px] text-muted-foreground text-center">
              No labels match "{query}"
            </li>
          ) : (
            filtered.map((l) => (
              <PopoverRow
                key={l.id}
                selected={selectedSet.has(l.id)}
                onClick={() => toggle(l.id)}
              >
                <LabelDot color={l.color} />
                <span className="flex-1 truncate">{l.name}</span>
                <span className="text-[10px] font-mono text-muted-foreground">{l.count}</span>
              </PopoverRow>
            ))
          )}
        </PopoverList>
      </FilterPopover>
    </>
  );
}

/** Small inline color dot for a label — hex without the leading #. */
function LabelDot({ color }: { color: string }): JSX.Element {
  const hex = color.startsWith('#') ? color : `#${color}`;
  return (
    <span
      className="inline-block h-3 w-3 rounded-full ring-2 ring-card shrink-0"
      style={{ backgroundColor: hex }}
      aria-hidden="true"
    />
  );
}

function CustomFieldFilters({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}): JSX.Element | null {
  const fieldsQuery = useQuery({
    queryKey: ['custom-fields', projectId],
    queryFn: () => api.get<CustomFieldDef[]>(`/projects/${projectId}/custom-fields`),
    enabled: Boolean(projectId),
  });
  const filterable = (fieldsQuery.data ?? []).filter((f) =>
    ['select', 'multiselect', 'checkbox'].includes(f.kind),
  );
  if (filterable.length === 0) return null;
  return (
    <>
      {filterable.map((f) => (
        <CustomFieldFilter
          key={f.id}
          field={f}
          value={value[f.id] ?? ''}
          onChange={(v) => {
            const next = { ...value };
            if (v) next[f.id] = v;
            else delete next[f.id];
            onChange(next);
          }}
        />
      ))}
    </>
  );
}

function CustomFieldFilter({
  field,
  value,
  onChange,
}: {
  field: CustomFieldDef;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const options =
    field.kind === 'checkbox'
      ? [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ]
      : field.options;
  const selectedLabel = options.find((o) => o.value === value)?.label;
  return (
    <>
      <FilterChip
        label={field.name}
        active={Boolean(value)}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {selectedLabel && <span className="truncate max-w-[110px]">{selectedLabel}</span>}
      </FilterChip>
      <FilterPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
      >
        <PopoverList>
          <PopoverRow
            selected={!value}
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
          >
            <span>{field.kind === 'checkbox' ? 'Any' : `All ${field.name.toLowerCase()}`}</span>
          </PopoverRow>
          {options.map((o) => (
            <PopoverRow
              key={o.value}
              selected={value === o.value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span>{o.label}</span>
            </PopoverRow>
          ))}
        </PopoverList>
      </FilterPopover>
    </>
  );
}

// =============================================================================
// Saved views — let users persist filter + view combinations and quickly switch.
// =============================================================================

function SavedViewsMenu({
  projectId,
  currentFilters,
  currentView,
  onApply,
}: {
  projectId?: string | undefined;
  currentFilters: TaskFilters;
  currentView: BoardView;
  onApply: (s: SavedView) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const viewsQuery = useQuery({
    queryKey: ['saved-views'],
    queryFn: () => api.get<SavedView[]>('/saved-views'),
  });
  // On a single-project board, only show views saved for that project. On a
  // workspace-scope board (projectId undefined), show every workspace view —
  // a saved view without a projectId is a "workspace dashboard".
  const myProjectViews = (viewsQuery.data ?? []).filter(
    (v) => !projectId || v.query.projectId === projectId || !v.query.projectId,
  );

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      api.post<SavedView>('/saved-views', {
        name,
        query: { projectId, filters: currentFilters, view: currentView },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-views'] });
      toast.success('View saved');
    },
    onError: () => toast.error('Could not save view'),
  });
  // Overwrites an existing view with the current filter + view (keeps the
  // original name and project scope). The "save changes" affordance.
  const overwriteMutation = useMutation({
    mutationFn: (view: SavedView) =>
      api.patch<SavedView>(`/saved-views/${view.id}`, {
        query: {
          projectId: view.query.projectId ?? projectId,
          filters: currentFilters,
          view: currentView,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-views'] });
      toast.success('View updated');
    },
    onError: () => toast.error('Could not update view'),
  });
  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<SavedView>(`/saved-views/${id}`, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-views'] });
      toast.success('Renamed');
    },
    onError: () => toast.error('Could not rename view'),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/saved-views/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-views'] });
    },
  });

  // Modal state for naming a view (save) or renaming one. A single dialog
  // covers both flows so we don't ship two near-identical components — and
  // both replace the native window.prompt() that used to fire here.
  const [nameDialog, setNameDialog] = useState<
    | { kind: 'save' }
    | { kind: 'rename'; viewId: string; currentName: string }
    | null
  >(null);

  const handleSave = () => {
    setOpen(false);
    setNameDialog({ kind: 'save' });
  };

  const handleNameDialogSubmit = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (nameDialog?.kind === 'save') {
      createMutation.mutate(trimmed);
    } else if (nameDialog?.kind === 'rename') {
      if (trimmed !== nameDialog.currentName) {
        renameMutation.mutate({ id: nameDialog.viewId, name: trimmed });
      }
    }
    setNameDialog(null);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="tap inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
      >
        <Bookmark className="h-3 w-3" />
        Views
        {myProjectViews.length > 0 && (
          <span className="ml-1 rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">{myProjectViews.length}</span>
        )}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default bg-transparent"
          />
          <div
            className="animate-popover-in absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-border bg-popover shadow-xl"
            style={{ transformOrigin: 'top right' }}
          >
            <header className="border-b border-border px-3 py-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Saved views
            </header>
            <ul className="max-h-72 overflow-y-auto py-1">
              {myProjectViews.length === 0 && (
                <li className="px-3 py-3 text-xs text-muted-foreground">
                  No saved views yet. Configure filters and save the current
                  combination below.
                </li>
              )}
              {myProjectViews.map((v) => (
                <li key={v.id} className="group flex items-stretch gap-1 px-2 py-1 text-sm hover:bg-muted/40 rounded">
                  <button
                    type="button"
                    onClick={() => {
                      onApply(v);
                      setOpen(false);
                    }}
                    className="flex-1 min-w-0 flex items-center gap-2 px-1.5 py-1 text-left"
                  >
                    <Bookmark className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="truncate">{v.name}</span>
                    {!v.query.projectId && (
                      <span className="ml-1 rounded bg-brand/15 px-1 py-px text-[9px] font-medium uppercase tracking-wider text-brand">
                        Workspace
                      </span>
                    )}
                  </button>
                  <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => overwriteMutation.mutate(v)}
                      className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                      aria-label="Update with current filters"
                      title="Update with current filters"
                    >
                      <BookmarkPlus className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        setNameDialog({ kind: 'rename', viewId: v.id, currentName: v.name });
                      }}
                      className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-[10px] font-bold"
                      aria-label="Rename view"
                      title="Rename view"
                    >
                      Aa
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`Delete view "${v.name}"?`)) deleteMutation.mutate(v.id);
                      }}
                      className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                      aria-label="Delete saved view"
                      title="Delete view"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <footer className="border-t border-border p-2">
              <button
                type="button"
                onClick={handleSave}
                className="tap inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
              >
                <BookmarkPlus className="h-3.5 w-3.5" />
                Save current as new view
              </button>
              <p className="mt-1.5 text-[10px] text-muted-foreground/70 text-center leading-relaxed">
                Hover a view to <span className="text-foreground">update</span>,{' '}
                <span className="text-foreground">rename</span>, or{' '}
                <span className="text-foreground">delete</span>.
              </p>
            </footer>
          </div>
        </>
      )}
      {nameDialog && (
        <NameViewDialog
          title={nameDialog.kind === 'save' ? 'Save view' : 'Rename view'}
          submitLabel={nameDialog.kind === 'save' ? 'Save view' : 'Rename'}
          defaultValue={nameDialog.kind === 'rename' ? nameDialog.currentName : ''}
          placeholder="e.g. My open bugs"
          onCancel={() => setNameDialog(null)}
          onSubmit={handleNameDialogSubmit}
        />
      )}
    </div>
  );
}

// =============================================================================
// NameViewDialog — in-app modal that replaces the native window.prompt() we
// used to fire for "Save this view" / "Rename view". Centered card over a
// scrim, autofocus the input, Enter to submit, Escape (or scrim click) to
// cancel. Portaled to document.body so it sits above any popover that opened
// it (and not affected by parent z-index stacking).
// =============================================================================

function NameViewDialog({
  title,
  submitLabel,
  defaultValue,
  placeholder,
  onCancel,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  defaultValue: string;
  placeholder?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}): JSX.Element {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const canSubmit = value.trim().length > 0;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-background/70 backdrop-blur-sm"
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(value);
        }}
        className="animate-popover-in relative z-[91] w-full max-w-sm rounded-xl border border-border bg-popover shadow-2xl shadow-black/50"
      >
        <header className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-1 nockta-eyebrow text-muted-foreground">
            Give it a short, memorable name.
          </p>
        </header>
        <div className="px-4 pb-3">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
            maxLength={80}
          />
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-3 py-2.5 bg-card/40 rounded-b-xl">
          <button
            type="button"
            onClick={onCancel}
            className="tap rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={cn(
              'tap rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              canSubmit
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-primary/30 text-primary-foreground/60 cursor-not-allowed',
            )}
          >
            {submitLabel}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

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
