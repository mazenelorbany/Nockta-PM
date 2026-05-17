import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Plus, Target, Trash2 } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { cn } from '@nockta/ui';
import {
  AvatarCircle,
  BlockedBadge,
  DueDateChip,
  PriorityDot,
  StatusPill,
  type Priority,
} from '../components/task-bits';
import { api } from '../lib/api';

type GoalStatus = 'active' | 'achieved' | 'dropped';

interface GoalListItem {
  id: string;
  name: string;
  description: string | null;
  status: GoalStatus;
  progress: number | null;
  startDate: string | null;
  targetDate: string | null;
  createdAt: string;
  owner: { id: string; name: string; email: string; avatarUrl?: string | null };
  _count: { tasks: number };
}

interface GoalDetail {
  id: string;
  name: string;
  description: string | null;
  status: GoalStatus;
  progress: number | null;
  startDate: string | null;
  targetDate: string | null;
  createdAt: string;
  owner: { id: string; name: string; email: string };
  tasks: {
    task: {
      id: string;
      keyNumber: number;
      title: string;
      status: string;
      priority: Priority;
      isBlocked: boolean;
      dueDate: string | null;
      project: { id: string; key: string; name: string };
      assignee?: { id: string; name: string } | null;
    };
  }[];
}

// =============================================================================

export function GoalsPage(): JSX.Element {
  const { goalId } = useParams<{ goalId?: string }>();
  return goalId ? <GoalDetailView goalId={goalId} /> : <GoalListView />;
}

function GoalListView(): JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [statusTab, setStatusTab] = useState<GoalStatus | 'all'>('active');

  const goalsQuery = useQuery({
    queryKey: ['goals', statusTab],
    queryFn: () =>
      api.get<GoalListItem[]>(
        statusTab === 'all' ? '/goals' : `/goals?status=${statusTab}`,
      ),
  });

  const goals = goalsQuery.data ?? [];

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-4 sm:py-5 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-xl font-semibold tracking-tight flex items-center gap-2">
            <Target className="h-5 w-5 text-brand" />
            Goals
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Strategic objectives linked to the tasks that move them.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity self-start sm:self-auto"
        >
          New goal
        </button>
      </header>

      {/* Tab strip — small pills, allowed to overflow horizontally on narrow
          phones rather than wrap to a second row. Audit exception. */}
      <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-1 overflow-x-auto">
        {(['active', 'achieved', 'dropped', 'all'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setStatusTab(t)}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors capitalize',
              statusTab === t
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-4 sm:p-6 md:p-8">
        {goalsQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : goals.length === 0 ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
            {goals.map((g) => (
              <GoalCard key={g.id} goal={g} />
            ))}
          </div>
        )}
      </div>

      {createOpen && <CreateGoalDialog onClose={() => setCreateOpen(false)} />}
    </div>
  );
}

function GoalCard({ goal }: { goal: GoalListItem }): JSX.Element {
  const pct = goal.progress ?? 0;
  return (
    <Link
      to={`/goals/${goal.id}`}
      className="block rounded-lg border border-border bg-card p-5 hover:border-ring transition-colors"
    >
      <div className="flex items-center justify-between mb-2">
        <GoalStatusPill status={goal.status} />
        <span className="text-xs text-muted-foreground">
          {goal._count.tasks} task{goal._count.tasks === 1 ? '' : 's'}
        </span>
      </div>
      <h3 className="text-base font-semibold tracking-tight">{goal.name}</h3>
      {goal.description && (
        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{goal.description}</p>
      )}
      <div className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="nockta-eyebrow text-muted-foreground">Progress</span>
          <span className="font-medium tabular-nums">{pct}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              'h-full transition-all',
              goal.status === 'achieved' ? 'bg-status-done' : 'bg-brand',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <AvatarCircle user={goal.owner} size={18} />
          {goal.owner.name}
        </span>
        {goal.targetDate && (
          <span>Target {new Date(goal.targetDate).toLocaleDateString()}</span>
        )}
      </div>
    </Link>
  );
}

function GoalStatusPill({ status }: { status: GoalStatus }): JSX.Element {
  const tone =
    status === 'active'   ? 'bg-status-in-progress/20 text-status-in-progress' :
    status === 'achieved' ? 'bg-status-done/20 text-status-done' :
                            'bg-status-todo/15 text-status-todo';
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide',
        tone,
      )}
    >
      {status}
    </span>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/30 p-12 text-center">
      <Target className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
      <h2 className="text-lg font-medium">No goals yet</h2>
      <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
        Goals capture what you're trying to achieve. Link tasks to them and the bar moves
        automatically as work gets done.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
      >
        Create your first goal
      </button>
    </div>
  );
}

// =============================================================================
// Detail view
// =============================================================================

interface KeyResult {
  id: string;
  name: string;
  unit: string | null;
  targetValue: number;
  currentValue: number;
  position: number;
}

function GoalDetailView({ goalId }: { goalId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const goalQuery = useQuery({
    queryKey: ['goal', goalId],
    queryFn: () => api.get<GoalDetail>(`/goals/${goalId}`),
  });
  const krQuery = useQuery({
    queryKey: ['goal', goalId, 'key-results'],
    queryFn: () => api.get<KeyResult[]>(`/goals/${goalId}/key-results`),
  });

  const update = useMutation({
    mutationFn: (patch: Partial<GoalDetail>) => api.patch(`/goals/${goalId}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goal', goalId] }),
    onError: (err) => toast.error(apiErrorMessage(err, 'Update failed')),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/goals/${goalId}`),
    onSuccess: () => {
      toast.success('Goal deleted');
      navigate('/goals');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Delete failed')),
  });
  const unlinkTask = useMutation({
    mutationFn: (taskId: string) => api.delete(`/goals/${goalId}/tasks/${taskId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goal', goalId] }),
    onError: (err) => toast.error(apiErrorMessage(err, 'Unlink failed')),
  });

  if (goalQuery.isLoading || !goalQuery.data) {
    return <div className="p-4 sm:p-6 md:p-8 text-muted-foreground">Loading…</div>;
  }
  const goal = goalQuery.data;
  const keyResults = krQuery.data ?? [];

  // Progress rollup priority:
  //   1. Explicit `goal.progress` override if set (manual entry wins).
  //   2. Mean of all key-result percentages when KRs exist (clamped 0–100).
  //   3. Otherwise derive from linked-task done ratio.
  const linkedTasks = goal.tasks.map((gt) => gt.task);
  const doneCount = linkedTasks.filter((t) => t.status === 'Done').length;
  const taskPct = linkedTasks.length === 0 ? 0 : Math.round((doneCount / linkedTasks.length) * 100);
  const krMeanPct = keyResults.length === 0
    ? null
    : Math.round(
        keyResults.reduce((sum, kr) => sum + krPercent(kr), 0) / keyResults.length,
      );
  const pct = goal.progress ?? krMeanPct ?? taskPct;
  const progressSource =
    goal.progress !== null
      ? 'manual'
      : krMeanPct !== null
        ? 'kr'
        : 'tasks';

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-4 sm:py-5 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-baseline gap-2 sm:gap-3 flex-wrap min-w-0">
          <Link to="/goals" className="text-xs text-muted-foreground hover:text-foreground shrink-0">
            ← Goals
          </Link>
          <h1 className="text-lg sm:text-xl font-semibold tracking-tight truncate">{goal.name}</h1>
          <GoalStatusPill status={goal.status} />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={goal.status}
            onChange={(e) => update.mutate({ status: e.target.value as GoalStatus })}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-xs"
          >
            <option value="active">Active</option>
            <option value="achieved">Achieved</option>
            <option value="dropped">Dropped</option>
          </select>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Delete "${goal.name}"?`)) remove.mutate();
            }}
            className="rounded-md px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
          >
            Delete
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 sm:p-6 md:p-8 space-y-4 sm:space-y-6 max-w-4xl">
        {/* Progress bar */}
        <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-3 mb-2">
            <div>
              <div className="nockta-eyebrow text-muted-foreground">Progress</div>
              <div className="text-3xl font-bold tabular-nums">{pct}%</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {progressSource === 'manual' && 'Manual override'}
                {progressSource === 'kr' &&
                  `Mean of ${keyResults.length} key result${keyResults.length === 1 ? '' : 's'}`}
                {progressSource === 'tasks' &&
                  `Auto from linked tasks (${doneCount}/${linkedTasks.length} done)`}
              </div>
            </div>
            <div className="sm:text-right text-xs text-muted-foreground space-y-0.5">
              {goal.startDate && <div>Start · {new Date(goal.startDate).toLocaleDateString()}</div>}
              {goal.targetDate && (
                <div>Target · {new Date(goal.targetDate).toLocaleDateString()}</div>
              )}
              <div className="flex items-center gap-1.5 sm:justify-end pt-1">
                <AvatarCircle user={goal.owner} size={18} />
                {goal.owner.name}
              </div>
            </div>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                'h-full transition-all',
                goal.status === 'achieved' ? 'bg-status-done' : 'bg-brand',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Key results — measurable sub-targets under the goal. Each KR has
            its own progress bar; the goal's rollup percentage uses the mean
            of these unless a manual override is set. */}
        <KeyResultsCard goalId={goalId} keyResults={keyResults} />

        {/* Description */}
        {goal.description && (
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="nockta-eyebrow text-muted-foreground mb-2">Description</div>
            <p className="text-sm whitespace-pre-wrap">{goal.description}</p>
          </div>
        )}

        {/* Linked tasks */}
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-baseline justify-between mb-3 gap-2">
            <h2 className="text-sm font-semibold">Linked tasks ({linkedTasks.length})</h2>
            <div className="flex items-center gap-3">
              <span className="nockta-eyebrow text-muted-foreground">
                {doneCount} done · {linkedTasks.length - doneCount} open
              </span>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors"
              >
                <Plus className="h-3 w-3" />
                Link tasks
              </button>
            </div>
          </div>
          {linkedTasks.length === 0 ? (
            <div className="text-xs text-muted-foreground py-3">
              No tasks linked yet. Click <span className="text-foreground">Link tasks</span> above
              to search across your projects and attach work that contributes to this goal.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {linkedTasks.map((t) => (
                <li
                  key={t.id}
                  className="group flex flex-wrap items-center gap-2 sm:gap-3 rounded-md border border-border bg-background/40 hover:bg-background hover:border-ring transition-colors px-3 py-2 text-sm"
                >
                  <PriorityDot priority={t.priority} />
                  <Link
                    to={`/projects/${t.project.id}/board?task=${t.id}`}
                    className="flex flex-wrap items-center gap-2 sm:gap-3 flex-1 min-w-0"
                  >
                    <span className="text-[11px] font-mono text-muted-foreground shrink-0 w-16">
                      {t.project.key}-{t.keyNumber}
                    </span>
                    <span className="flex-1 min-w-0 truncate basis-full sm:basis-auto">{t.title}</span>
                    <BlockedBadge blocked={t.isBlocked} />
                    <DueDateChip dueDate={t.dueDate} done={t.status === 'Done'} />
                    <StatusPill status={t.status} />
                  </Link>
                  <button
                    type="button"
                    onClick={() => unlinkTask.mutate(t.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive text-xs shrink-0"
                  >
                    Unlink
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {pickerOpen && (
        <LinkTasksDialog
          goalId={goalId}
          alreadyLinkedIds={new Set(linkedTasks.map((t) => t.id))}
          onClose={() => setPickerOpen(false)}
          onLinked={() => {
            void queryClient.invalidateQueries({ queryKey: ['goal', goalId] });
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
// LinkTasksDialog — multi-select task picker that searches across every
// project the user can see. Replaces the old "use the goal picker (coming
// soon in the drawer)" empty-state copy. Free-text search hits the existing
// /search endpoint, results render as a checklist, and the bulk submit
// fires N POST /goals/:id/tasks/:taskId in parallel.
//
// Excludes tasks already linked to the goal so the user can't double-link.
// The dialog closes only after every link succeeds so a partial failure
// doesn't leave the user wondering which ones landed.
// =============================================================================

interface PickerTask {
  id: string;
  title: string;
  status: string;
  keyNumber: number;
  project: { id: string; key: string; name: string };
}

function LinkTasksDialog({
  goalId,
  alreadyLinkedIds,
  onClose,
  onLinked,
}: {
  goalId: string;
  alreadyLinkedIds: Set<string>;
  onClose: () => void;
  onLinked: () => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Debounce the search by query value so each keystroke doesn't fire a
  // request. We rely on react-query's `enabled` to skip the empty query
  // case (which would 400 on the backend).
  const search = useQuery({
    queryKey: ['goal-picker', q],
    queryFn: () =>
      api.get<{ tasks: PickerTask[] }>(`/search?q=${encodeURIComponent(q)}&limit=30`),
    enabled: q.trim().length >= 2,
  });

  const linkAll = useMutation({
    mutationFn: async () => {
      const ids = Array.from(picked);
      // Sequential rather than parallel: each call is cheap, but a guest with
      // permissions for some projects but not others would otherwise get a
      // confused mix of 200 + 403 responses. Sequential gives us a clean
      // first-failure to surface.
      for (const id of ids) {
        await api.post(`/goals/${goalId}/tasks/${id}`, {});
      }
      return ids.length;
    },
    onSuccess: (count) => {
      toast.success(`Linked ${count} task${count === 1 ? '' : 's'}`);
      onLinked();
      onClose();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Link failed')),
  });

  const candidates = (search.data?.tasks ?? []).filter((t) => !alreadyLinkedIds.has(t.id));

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md md:max-w-2xl rounded-lg border border-border bg-card shadow-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold">Link tasks to this goal</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Search across every project you can see. Pick the tasks that contribute to this goal.
          </p>
          <input
            type="search"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, description, or task key…"
            className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {q.trim().length < 2 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">
              Type at least 2 characters to search.
            </div>
          ) : search.isLoading ? (
            <div className="text-xs text-muted-foreground py-6 text-center">Searching…</div>
          ) : candidates.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">
              No matches. Try a different search.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {candidates.map((t) => {
                const isPicked = picked.has(t.id);
                return (
                  <li key={t.id}>
                    <label className="flex items-center gap-3 px-2 py-2 hover:bg-accent/40 rounded cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isPicked}
                        onChange={(e) => {
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(t.id);
                            else next.delete(t.id);
                            return next;
                          });
                        }}
                      />
                      <span className="text-[10px] font-mono text-muted-foreground w-16 shrink-0">
                        {t.project.key}-{t.keyNumber}
                      </span>
                      <span className="flex-1 text-sm truncate">{t.title}</span>
                      <StatusPill status={t.status} />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {picked.size} selected
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={picked.size === 0 || linkAll.isPending}
              onClick={() => linkAll.mutate()}
              className="rounded-md bg-foreground text-background px-4 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {linkAll.isPending ? 'Linking…' : `Link ${picked.size || ''}`.trim()}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// =============================================================================

function CreateGoalDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetDate, setTargetDate] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post<GoalDetail>('/goals', {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(targetDate ? { targetDate: new Date(targetDate).toISOString() } : {}),
      }),
    onSuccess: (goal) => {
      toast.success('Goal created');
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      onClose();
      navigate(`/goals/${goal.id}`);
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not create goal')),
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">New goal</h2>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">Name</label>
            <input
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Reach $1M ARR by Q4"
              maxLength={200}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">
              Description
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={5000}
              placeholder="The why behind it"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
            />
          </div>
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">
              Target date
            </label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="px-6 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create goal'}
          </button>
        </div>
      </form>
    </div>
  );
}

// =============================================================================
// Key results — measurable sub-targets under a goal. Each KR is a Name +
// current/target numeric pair with a free-text unit. Editing the current
// value updates the goal's rollup percentage in real time.
// =============================================================================

function krPercent(kr: KeyResult): number {
  if (kr.targetValue === 0) return 0;
  // Allow over-achievement to clamp at 100 so the UI stays sensible. We could
  // surface the literal ratio elsewhere if a "stretch" KR ever matters.
  return Math.max(0, Math.min(100, Math.round((kr.currentValue / kr.targetValue) * 100)));
}

function KeyResultsCard({
  goalId,
  keyResults,
}: {
  goalId: string;
  keyResults: KeyResult[];
}): JSX.Element {
  const queryClient = useQueryClient();
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['goal', goalId, 'key-results'] });
    void queryClient.invalidateQueries({ queryKey: ['goal', goalId] });
  };

  const create = useMutation({
    mutationFn: (body: { name: string; targetValue: number; unit?: string }) =>
      api.post(`/goals/${goalId}/key-results`, body),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not add key result')),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<KeyResult> }) =>
      api.patch(`/goals/key-results/${id}`, body),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/goals/key-results/${id}`),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete')),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftTarget, setDraftTarget] = useState('100');
  const [draftUnit, setDraftUnit] = useState('');

  function submitAdd(e: React.FormEvent): void {
    e.preventDefault();
    const target = Number(draftTarget);
    if (!draftName.trim() || !Number.isFinite(target) || target <= 0) return;
    create.mutate({
      name: draftName.trim(),
      targetValue: target,
      ...(draftUnit.trim() ? { unit: draftUnit.trim() } : {}),
    });
    setDraftName('');
    setDraftTarget('100');
    setDraftUnit('');
    setAddOpen(false);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">Key results ({keyResults.length})</h2>
        <button
          type="button"
          onClick={() => setAddOpen((o) => !o)}
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <Plus className="h-3 w-3" />
          {addOpen ? 'Cancel' : 'Add KR'}
        </button>
      </div>

      {keyResults.length === 0 && !addOpen ? (
        <p className="text-xs text-muted-foreground">
          No key results yet. KRs make goals measurable —{' '}
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="text-brand hover:underline"
          >
            add one
          </button>
          .
        </p>
      ) : (
        <KeyResultsSortableList
          keyResults={keyResults}
          onUpdate={(id, body) => update.mutate({ id, body })}
          onRemove={(id) => remove.mutate(id)}
        />
      )}

      {addOpen && (
        <form
          onSubmit={submitAdd}
          className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_100px_100px_auto] gap-2 items-start border-t border-border/60 pt-3"
        >
          <input
            required
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Key result name"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <input
            type="number"
            min="0.01"
            step="any"
            value={draftTarget}
            onChange={(e) => setDraftTarget(e.target.value)}
            placeholder="Target"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono"
          />
          <input
            value={draftUnit}
            onChange={(e) => setDraftUnit(e.target.value)}
            placeholder="Unit (optional)"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <button
            type="submit"
            disabled={!draftName.trim() || Number(draftTarget) <= 0}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition"
          >
            Add
          </button>
        </form>
      )}
    </div>
  );
}

// =============================================================================
// KeyResultsSortableList — dnd-kit-powered reorderable list. Replaces the
// earlier up/down-arrow swap. Drag handle is a tiny grip-vertical icon that
// reveals on hover; the entire row is also keyboard-sortable via dnd-kit's
// KeyboardSensor (Tab to focus a handle, Space to pick up, arrow keys to
// move, Space again to drop). After a drop we send N position updates for
// the items whose positions changed — the backend orders by `position` asc.
// =============================================================================

interface KeyResultRowCallbacks {
  onUpdate: (id: string, body: Partial<KeyResult>) => void;
  onRemove: (id: string) => void;
}

function KeyResultsSortableList({
  keyResults,
  onUpdate,
  onRemove,
}: { keyResults: KeyResult[] } & KeyResultRowCallbacks): JSX.Element {
  // Pointer sensor with a small activation distance so a click on the inline
  // name/value inputs doesn't accidentally start a drag. Keyboard sensor
  // gives full a11y — Tab to handle, Space to pick up, Arrow keys to move.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = keyResults.findIndex((kr) => kr.id === active.id);
    const newIndex = keyResults.findIndex((kr) => kr.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(keyResults, oldIndex, newIndex);
    // Renumber positions starting at 0 along the new order, then send an
    // update for every KR whose position actually changed. Avoids writing
    // N rows when only 2 shifted. For larger lists this is O(N) writes but
    // KR lists are typically 2-5 items so the cost is fine.
    for (let i = 0; i < reordered.length; i++) {
      const kr = reordered[i]!;
      if (kr.position !== i) {
        onUpdate(kr.id, { position: i });
      }
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext
        items={keyResults.map((kr) => kr.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="space-y-3">
          {keyResults.map((kr) => (
            <SortableKeyResult
              key={kr.id}
              kr={kr}
              onUpdate={onUpdate}
              onRemove={onRemove}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableKeyResult({
  kr,
  onUpdate,
  onRemove,
}: { kr: KeyResult } & KeyResultRowCallbacks): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: kr.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  const pct = krPercent(kr);

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="group rounded-md border border-border/60 bg-background/40 p-3"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        {/* Drag handle. `listeners` MUST be on this button only — putting
            them on the row would steal pointerdown from the inline inputs
            and break editing. */}
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Reorder key result (drag, or use keyboard: Tab → Space → Arrow keys)"
          className="text-muted-foreground/40 hover:text-foreground cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition touch-none"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <input
          defaultValue={kr.name}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== kr.name) onUpdate(kr.id, { name: v });
          }}
          className="flex-1 bg-transparent text-sm font-medium focus:outline-none"
        />
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete "${kr.name}"?`)) onRemove(kr.id);
          }}
          aria-label="Delete key result"
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition p-1"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
        <input
          type="number"
          defaultValue={kr.currentValue}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v !== kr.currentValue) {
              onUpdate(kr.id, { currentValue: v });
            }
          }}
          className="w-20 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground font-mono"
        />
        <span>/</span>
        <input
          type="number"
          defaultValue={kr.targetValue}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0 && v !== kr.targetValue) {
              onUpdate(kr.id, { targetValue: v });
            }
          }}
          className="w-20 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground font-mono"
        />
        {kr.unit && <span className="text-muted-foreground">{kr.unit}</span>}
        <span className="ml-auto font-medium tabular-nums text-foreground">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full transition-all',
            pct >= 100 ? 'bg-status-done' : 'bg-brand',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </li>
  );
}

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.problem.title || err.problem.detail || err.message || fallback;
  return fallback;
}
