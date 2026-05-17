import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, ArrowRight, Check, Clock, Inbox, Play, Plus, Search, Target, Users, X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { cn } from '@nockta/ui';
import {
  AvatarCircle,
  BlockedBadge,
  PriorityDot,
  StatusPill,
  TypeBadge,
  type Priority,
  type TaskType,
} from '../components/task-bits';
import { api } from '../lib/api';

// =============================================================================
// /projects/:projectId/sprints/:sprintId/plan
// ClickUp-style sprint planner: Backlog on the left, Sprint on the right.
// Drag tasks between panes, or click a single task to move it. The page shows
// live capacity (count + sum-of-estimates + per-assignee load) so a planner
// can size the sprint as they go.
// =============================================================================

interface Project {
  id: string;
  key: string;
  name: string;
  sprintsEnabled: boolean;
  workflowPreset: 'engineering' | 'design' | 'generic';
}

interface Sprint {
  id: string;
  projectId: string;
  name: string;
  state: 'planned' | 'active' | 'completed';
  startDate: string | null;
  endDate: string | null;
}

interface Label {
  id: string;
  name: string;
  color: string;
}

interface PlannerTask {
  id: string;
  key: string;
  title: string;
  status: string;
  priority: Priority;
  type?: TaskType;
  isBlocked: boolean;
  estimate: number | null;
  dueDate: string | null;
  assignee?: { id: string; name: string; avatarUrl?: string | null } | null;
  labels: Label[];
  _count?: { subtasks: number };
}

type Side = 'backlog' | 'sprint';

export function SprintPlanningPage(): JSX.Element {
  const { projectId = '', sprintId = '' } = useParams<{ projectId: string; sprintId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const sprintsQuery = useQuery({
    queryKey: ['sprints', projectId],
    queryFn: () => api.get<Sprint[]>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId),
  });
  const backlogQuery = useQuery({
    queryKey: ['backlog', projectId],
    queryFn: () => api.get<PlannerTask[]>(`/projects/${projectId}/backlog`),
    enabled: Boolean(projectId),
  });
  const sprintTasksQuery = useQuery({
    queryKey: ['sprint-tasks', sprintId],
    queryFn: () => api.get<PlannerTask[]>(`/sprints/${sprintId}/tasks`),
    enabled: Boolean(sprintId),
  });

  const project = projectQuery.data;
  const sprint = (sprintsQuery.data ?? []).find((s) => s.id === sprintId) ?? null;
  const backlog = backlogQuery.data ?? [];
  const sprintTasks = sprintTasksQuery.data ?? [];

  // Filter state — applied to BOTH panes so the planner can focus by assignee
  // or label without losing visibility of what's already in the sprint.
  const [search, setSearch] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('');
  const [priorityFilter, setPriorityFilter] = useState<Priority | ''>('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const invalidateBoth = () => {
    void queryClient.invalidateQueries({ queryKey: ['backlog', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['sprint-tasks', sprintId] });
    void queryClient.invalidateQueries({ queryKey: ['tasks', 'project', projectId] });
  };

  const addToSprint = useMutation({
    mutationFn: (taskIds: string[]) =>
      api.post(`/sprints/${sprintId}/tasks`, { taskIds }),
    onSuccess: (_, taskIds) => {
      toast.success(`${taskIds.length} ${taskIds.length === 1 ? 'task' : 'tasks'} → ${sprint?.name ?? 'sprint'}`);
      invalidateBoth();
      setSelected(new Set());
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not add to sprint')),
  });
  const removeFromSprint = useMutation({
    mutationFn: (taskId: string) => api.delete(`/sprints/${sprintId}/tasks/${taskId}`),
    onSuccess: () => {
      invalidateBoth();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not remove from sprint')),
  });
  const startSprint = useMutation({
    mutationFn: () => api.post(`/sprints/${sprintId}/start`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
      toast.success('Sprint started');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not start sprint')),
  });

  // ---------- Filtering ----------
  const filteredBacklog = useMemo(
    () => applyFilters(backlog, search, assigneeFilter, priorityFilter),
    [backlog, search, assigneeFilter, priorityFilter]
  );
  const filteredSprint = useMemo(
    () => applyFilters(sprintTasks, search, assigneeFilter, priorityFilter),
    [sprintTasks, search, assigneeFilter, priorityFilter]
  );

  // ---------- Capacity ----------
  const capacity = useMemo(() => {
    const points = sprintTasks.reduce((acc, t) => acc + (t.estimate ?? 0), 0);
    const byAssignee = new Map<string, { name: string; avatarUrl?: string | null; count: number; points: number }>();
    let unassignedCount = 0;
    let unassignedPoints = 0;
    for (const t of sprintTasks) {
      if (!t.assignee) {
        unassignedCount += 1;
        unassignedPoints += t.estimate ?? 0;
        continue;
      }
      const cur = byAssignee.get(t.assignee.id) ?? {
        name: t.assignee.name,
        avatarUrl: (t.assignee.avatarUrl ?? null) as string | null,
        count: 0,
        points: 0,
      };
      cur.count += 1;
      cur.points += t.estimate ?? 0;
      byAssignee.set(t.assignee.id, cur);
    }
    return {
      count: sprintTasks.length,
      points,
      byAssignee: Array.from(byAssignee.entries()).map(([id, v]) => ({ id, ...v })),
      unassignedCount,
      unassignedPoints,
    };
  }, [sprintTasks]);

  // Unique assignees across both lists for the filter dropdown.
  const assigneeOptions = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const t of [...backlog, ...sprintTasks]) {
      if (t.assignee) m.set(t.assignee.id, { id: t.assignee.id, name: t.assignee.name });
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [backlog, sprintTasks]);

  // ---------- Drag-and-drop ----------
  const [dragging, setDragging] = useState<{ id: string; from: Side } | null>(null);
  function onDragStart(e: DragStartEvent): void {
    const data = e.active.data.current as { from: Side } | undefined;
    if (data) setDragging({ id: e.active.id as string, from: data.from });
  }
  function onDragEnd(e: DragEndEvent): void {
    setDragging(null);
    const overId = e.over?.id;
    const data = e.active.data.current as { from: Side } | undefined;
    if (!overId || !data) return;
    const targetSide: Side = overId === 'pane-sprint' ? 'sprint' : 'backlog';
    if (data.from === targetSide) return;
    if (targetSide === 'sprint') {
      addToSprint.mutate([e.active.id as string]);
    } else {
      removeFromSprint.mutate(e.active.id as string);
    }
  }

  if (!project) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!sprint) {
    return (
      <div className="p-8 space-y-3">
        <p className="text-sm text-muted-foreground">Sprint not found.</p>
        <Link to={`/projects/${projectId}/backlog`} className="text-xs text-primary hover:underline">
          ← Back to backlog
        </Link>
      </div>
    );
  }

  const canModify = sprint.state !== 'completed';

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <header className="px-4 sm:px-6 md:px-8 py-4 sm:py-5 border-b border-border">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <Link
                to={`/projects/${projectId}/backlog`}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-1"
              >
                <ArrowLeft className="h-3 w-3" />
                {project.key} · Backlog
              </Link>
              <h1 className="text-xl font-semibold tracking-tight">
                Plan: <span className="text-foreground">{sprint.name}</span>
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                Drag tasks from the backlog into the sprint, or click to toggle. Estimates roll up
                live on the right.
                {sprint.startDate || sprint.endDate ? (
                  <>
                    {' '}
                    <span className="ml-1">
                      {sprint.startDate ? new Date(sprint.startDate).toLocaleDateString() : '—'}
                      {' → '}
                      {sprint.endDate ? new Date(sprint.endDate).toLocaleDateString() : '—'}
                    </span>
                  </>
                ) : null}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {sprint.state === 'planned' && canModify && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Start "${sprint.name}"? Only one sprint can be active per project.`)) {
                      startSprint.mutate();
                    }
                  }}
                  disabled={startSprint.isPending || sprintTasks.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition"
                  title={sprintTasks.length === 0 ? 'Add at least one task before starting' : 'Start sprint'}
                >
                  <Play className="h-3.5 w-3.5" />
                  Start sprint
                </button>
              )}
              {sprint.state === 'active' && (
                <Link
                  to={`/projects/${projectId}/board?sprint=${sprintId}`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition"
                >
                  Open board
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              )}
            </div>
          </div>
        </header>

        {/* Toolbar — search + filters apply to both panes */}
        <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-2 flex-wrap">
          <label className="relative flex-1 sm:flex-none">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks…"
              className="h-7 w-full sm:w-64 rounded-md bg-secondary/60 pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
            />
          </label>
          <Pill
            label="Assignee"
            value={assigneeFilter}
            onChange={setAssigneeFilter}
            options={[{ value: '', label: 'Anyone' }, ...assigneeOptions.map((u) => ({ value: u.id, label: u.name }))]}
          />
          <Pill
            label="Priority"
            value={priorityFilter}
            onChange={(v) => setPriorityFilter(v as Priority | '')}
            options={[
              { value: '', label: 'All priorities' },
              { value: 'Critical', label: 'Critical' },
              { value: 'High', label: 'High' },
              { value: 'Medium', label: 'Medium' },
              { value: 'Low', label: 'Low' },
            ]}
          />
          {(search || assigneeFilter || priorityFilter) && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setAssigneeFilter('');
                setPriorityFilter('');
              }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => addToSprint.mutate(Array.from(selected))}
              disabled={addToSprint.isPending}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition disabled:opacity-50"
            >
              <ArrowRight className="h-3.5 w-3.5" />
              Add {selected.size} to sprint
            </button>
          )}
        </div>

        {/* Two-pane planner */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_1fr] divide-y lg:divide-y-0 lg:divide-x divide-border overflow-hidden">
          {/* Backlog pane */}
          <Pane
            id="pane-backlog"
            title="Backlog"
            icon={<Inbox className="h-3.5 w-3.5 text-muted-foreground" />}
            count={filteredBacklog.length}
            empty="No tasks in the backlog. Create one from the board, then come back here to plan."
            highlight={dragging?.from === 'sprint'}
            onCreateHref={`/projects/${projectId}/board`}
          >
            {filteredBacklog.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                side="backlog"
                isSelected={selected.has(t.id)}
                {...(canModify
                  ? {
                      onToggleSelect: () => toggleSelected(setSelected, t.id),
                      onPrimary: () => addToSprint.mutate([t.id]),
                    }
                  : {})}
                primaryIcon={<ArrowRight className="h-3 w-3" />}
                primaryLabel="Add to sprint"
              />
            ))}
          </Pane>

          {/* Sprint pane */}
          <Pane
            id="pane-sprint"
            title={sprint.name}
            icon={<Target className="h-3.5 w-3.5 text-primary" />}
            count={filteredSprint.length}
            empty="No tasks in this sprint yet. Drag from the backlog, or click → next to any task."
            highlight={dragging?.from === 'backlog'}
            summary={
              <SprintCapacityBar
                count={capacity.count}
                points={capacity.points}
                unassignedCount={capacity.unassignedCount}
                unassignedPoints={capacity.unassignedPoints}
                byAssignee={capacity.byAssignee}
              />
            }
          >
            {filteredSprint.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                side="sprint"
                {...(canModify
                  ? { onPrimary: () => removeFromSprint.mutate(t.id) }
                  : {})}
                primaryIcon={<ArrowLeft className="h-3 w-3" />}
                primaryLabel="Remove from sprint"
              />
            ))}
          </Pane>
        </div>
      </div>
    </DndContext>
  );
}

// =============================================================================
// Pane — a droppable column with header + scrollable list.
// =============================================================================

function Pane({
  id,
  title,
  icon,
  count,
  empty,
  highlight,
  summary,
  onCreateHref,
  children,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  count: number;
  empty: string;
  highlight?: boolean;
  summary?: React.ReactNode;
  onCreateHref?: string;
  children: React.ReactNode;
}): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section
      ref={setNodeRef}
      className={cn(
        'flex flex-col min-h-0 transition-colors',
        (highlight || isOver) && 'bg-primary/5'
      )}
    >
      <header className="px-5 py-3 border-b border-border bg-card/40 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <span className="text-[11px] text-muted-foreground">{count}</span>
        </div>
        {onCreateHref && (
          <Link
            to={onCreateHref}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3 w-3" /> New
          </Link>
        )}
      </header>
      {summary && <div className="px-5 py-2 border-b border-border bg-card/20">{summary}</div>}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {count === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-12 px-4">{empty}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

// =============================================================================
// TaskRow — single draggable task. Click anywhere to toggle select; click the
// chevron arrow to perform the primary action (add to sprint / remove from).
// =============================================================================

function TaskRow({
  task,
  side,
  isSelected,
  onToggleSelect,
  onPrimary,
  primaryIcon,
  primaryLabel,
}: {
  task: PlannerTask;
  side: Side;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  onPrimary?: () => void;
  primaryIcon: React.ReactNode;
  primaryLabel: string;
}): JSX.Element {
  const { setNodeRef, attributes, listeners, transform, isDragging } = useDraggable({
    id: task.id,
    data: { from: side },
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex items-start gap-2.5 rounded-md border bg-card/60 px-3 py-2 text-xs transition',
        'hover:border-primary/40 hover:bg-card/80',
        isSelected && 'border-primary/60 bg-primary/5',
        isDragging && 'opacity-50',
      )}
    >
      {onToggleSelect && (
        <input
          type="checkbox"
          checked={isSelected ?? false}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
          className={cn(
            'mt-0.5 h-3.5 w-3.5 cursor-pointer',
            isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          aria-label={`Select ${task.key}`}
        />
      )}
      <button
        type="button"
        {...listeners}
        {...attributes}
        className="flex-1 text-left cursor-grab active:cursor-grabbing min-w-0"
      >
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-mono text-[10px] text-muted-foreground">{task.key}</span>
          {task.type && <TypeBadge type={task.type} />}
          <PriorityDot priority={task.priority} />
          <BlockedBadge blocked={task.isBlocked} />
        </div>
        <div className="text-sm font-medium leading-snug line-clamp-2">{task.title}</div>
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          <StatusPill status={task.status} />
          {task.labels.slice(0, 3).map((l) => (
            <span
              key={l.id}
              className="rounded px-1.5 py-0.5 text-[10px]"
              style={{ backgroundColor: `#${l.color}22`, color: `#${l.color}` }}
            >
              {l.name}
            </span>
          ))}
          {task.labels.length > 3 && (
            <span className="text-[10px] text-muted-foreground">+{task.labels.length - 3}</span>
          )}
          {task._count && task._count.subtasks > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {task._count.subtasks} subtasks
            </span>
          )}
          {task.estimate !== null && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              {task.estimate}
            </span>
          )}
          {task.assignee && <AvatarCircle user={task.assignee} size={16} />}
        </div>
      </button>
      {onPrimary && (
        <button
          type="button"
          onClick={onPrimary}
          aria-label={primaryLabel}
          title={primaryLabel}
          className={cn(
            'shrink-0 rounded-md p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary',
            'opacity-0 group-hover:opacity-100 transition-opacity',
          )}
        >
          {primaryIcon}
        </button>
      )}
    </div>
  );
}

// =============================================================================
// SprintCapacityBar — rolled-up stats above the Sprint pane.
// =============================================================================

function SprintCapacityBar({
  count,
  points,
  unassignedCount,
  unassignedPoints,
  byAssignee,
}: {
  count: number;
  points: number;
  unassignedCount: number;
  unassignedPoints: number;
  byAssignee: { id: string; name: string; avatarUrl?: string | null; count: number; points: number }[];
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 text-xs flex-wrap">
      <div className="flex items-center gap-4">
        <Stat label="Tasks" value={count} />
        <Stat label="Points" value={points} />
        {unassignedCount > 0 && (
          <Stat label="Unassigned" value={`${unassignedCount} · ${unassignedPoints} pts`} tone="warning" />
        )}
      </div>
      {byAssignee.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <Users className="h-3 w-3 text-muted-foreground" />
          {byAssignee.slice(0, 6).map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 rounded-full bg-secondary/60 px-2 py-0.5"
              title={`${a.name}: ${a.count} tasks${a.points ? ` · ${a.points} pts` : ''}`}
            >
              <AvatarCircle user={{ id: a.id, name: a.name, avatarUrl: a.avatarUrl ?? null }} size={14} />
              <span className="text-[10px] font-medium">{a.count}</span>
              {a.points > 0 && <span className="text-[10px] text-muted-foreground">· {a.points}</span>}
            </span>
          ))}
          {byAssignee.length > 6 && (
            <span className="text-[10px] text-muted-foreground">+{byAssignee.length - 6} more</span>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'warning' }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="nockta-eyebrow text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-semibold tabular-nums',
          tone === 'warning' && 'text-priority-high'
        )}
      >
        {value}
      </span>
    </span>
  );
}

// =============================================================================
// Filter helper
// =============================================================================

function applyFilters(
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

function toggleSelected(setSel: React.Dispatch<React.SetStateAction<Set<string>>>, id: string): void {
  setSel((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

// =============================================================================
// Pill (chip-style select)
// =============================================================================

function Pill({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  const isActive = value !== '';
  const current = options.find((o) => o.value === value);
  return (
    <label
      className={cn(
        'relative inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer transition-colors',
        isActive
          ? 'border-brand/40 bg-accent text-foreground'
          : 'border-border bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="nockta-eyebrow text-[0.6rem] opacity-60">{label}</span>
      {isActive && <span className="truncate max-w-[120px]">{current?.label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.problem.detail) return err.problem.detail;
    if (err.problem.title) return err.problem.title;
  }
  return fallback;
}
