import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { generateKeyBetween } from 'fractional-indexing';
import { CheckCircle2, ChevronLeft, ChevronRight, Clock, FileText, Play, Sun, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { cn, QueryErrorState, Spinner } from '@nockta/ui';
import {
  BoardToolbar,
  EMPTY_FILTERS,
  applyTaskFilters,
  type BoardView,
  type TaskFilters,
} from '../components/board-toolbar';
import { ProjectListView } from '../components/ProjectListView';
import { PresenceAvatars } from '../components/PresenceAvatars';
import { ProjectTabs } from '../components/ProjectTabs';
import { StandupRunner } from '../components/StandupRunner';
import {
  AtRiskBadge,
  AvatarCircle,
  BlockedBadge,
  DueDateChip,
  PriorityDot,
  StatusPill,
  TypeBadge,
  type TaskType,
} from '../components/task-bits';
import { TaskDetailDrawer } from '../components/TaskDetailDrawer';
import { PullIndicator, usePullToRefresh } from '../hooks/usePullToRefresh';
import { isHorizontalDominant } from '../hooks/useSwipeGesture';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import {
  ESTIMATED_CARD_HEIGHT,
  useVirtualizer,
  VIRTUALIZE_THRESHOLD,
} from '../lib/virtualizer';

type Priority = 'Low' | 'Medium' | 'High' | 'Critical';
type Preset = 'engineering' | 'design' | 'generic';

interface Task {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  aiRiskReason?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  sprintId?: string | null;
  parentTaskId?: string | null;
  /** Fractional-index key. Used to position cards within a column. */
  boardPosition: string;
  assignee?: { id: string; name: string; avatarUrl?: string };
  labels?: Array<{ label: { id: string; name: string; color: string } }>;
  customFieldValues?: CustomFieldValue[];
}

interface CustomFieldValue {
  id: string;
  fieldId: string;
  value: unknown;
  field: {
    id: string;
    name: string;
    kind: 'text' | 'number' | 'select' | 'multiselect' | 'date' | 'url' | 'checkbox';
    position: number;
    options: { value: string; label: string; color?: string }[];
  };
}

interface Project {
  id: string;
  key: string;
  name: string;
  workflowPreset: Preset;
  sprintsEnabled?: boolean;
}

interface ActiveSprint {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  state: 'planned' | 'active' | 'completed';
  /** Optional sprint goal/theme — rendered as a banner under the active-sprint
   *  chip on the project board so the team sees their north-star sentence
   *  every time they open the board. */
  goal: string | null;
}

interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

const PRESET_STATUSES: Record<Preset, string[]> = {
  engineering: ['Todo', 'In Progress', 'In Review', 'Testing', 'Done'],
  design:      ['Todo', 'In Progress', 'In Review', 'Approved', 'Done'],
  generic:     ['Todo', 'In Progress', 'Done'],
};

export function ProjectBoardPage(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get('task');
  const queryClient = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [createOpen, setCreateOpen] = useState(false);
  const [defaultStatus, setDefaultStatus] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // View defaults to whatever `?view=` is in the URL on first render so the
  // sidebar's "List" sub-link lands directly on the list rather than the board.
  const initialView: BoardView = searchParams.get('view') === 'list' ? 'list' : 'board';
  const [view, setView] = useState<BoardView>(initialView);
  // Initial filters read ?sprint= from the URL so "View board" on a sprint
  // card lands on a board pre-filtered to that sprint.
  const initialSprintParam = searchParams.get('sprint');
  const [filters, setFilters] = useState<TaskFilters>(() => ({
    ...EMPTY_FILTERS,
    ...(initialSprintParam ? { sprintId: initialSprintParam } : {}),
  }));

  // Standup mode: overlays a left panel with a per-person timer that walks
  // the team through the board one assignee at a time. Live state only —
  // not persisted across reloads, since standups are a single-session ritual.
  const [standupOpen, setStandupOpen] = useState(false);
  // Mobile kanban carousel — at <md viewport we render ONE column at a time
  // with a dot-strip indicator and arrow buttons. `isMobile` is derived from
  // a matchMedia listener so it stays in sync on rotate/resize. The mobile
  // index is clamped against `columns.length` further down once it's known.
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  const [mobileColumnIdx, setMobileColumnIdx] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // While the standup runner is live, remember the user's assignee filter so
  // we can restore it after the standup ends. This way running a standup
  // doesn't permanently change the filters the user had in place. `null`
  // means "we haven't captured the pre-standup state yet."
  const preStandupAssigneeFilter = useRef<string | undefined | null>(null);

  /**
   * Called by StandupRunner when the active speaker rotates. We narrow the
   * board to the current speaker's tasks so the team is visually focused on
   * whoever's talking. The `unassigned` sentinel is the same one the
   * Assignee filter understands.
   */
  const handleSpeakerChange = useCallback(
    (userId: string | null) => {
      setFilters((prev) => {
        // Capture once on the first call so we don't keep snapshotting filters
        // that we just set ourselves.
        if (preStandupAssigneeFilter.current === null && userId !== null) {
          preStandupAssigneeFilter.current = prev.assigneeUserId;
        }
        if (userId === null) {
          // Standup ended — restore whatever the user had before.
          const restore = preStandupAssigneeFilter.current;
          preStandupAssigneeFilter.current = null;
          return { ...prev, assigneeUserId: restore ?? undefined };
        }
        // The runner uses '__unassigned__' for the no-assignee slot; the
        // BoardToolbar's AssigneeFilter expects 'unassigned' for the same.
        const filterValue = userId === '__unassigned__' ? 'unassigned' : userId;
        return { ...prev, assigneeUserId: filterValue };
      });
    },
    [],
  );

  // Keep ?view in sync as the user toggles tabs (so refreshes preserve view).
  useEffect(() => {
    setSearchParams((sp) => {
      if (view === 'list') sp.set('view', 'list');
      else sp.delete('view');
      return sp;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Apply a saved view from the sidebar via ?savedView=ID. Fetches /saved-views,
  // looks up the matching id, applies its filters + view, then strips the param
  // so subsequent toolbar changes don't get clobbered on URL update.
  const savedViewParam = searchParams.get('savedView');
  const savedViewsQuery = useQuery({
    queryKey: ['saved-views'],
    queryFn: () =>
      api.get<{ id: string; name: string; query: { projectId?: string; filters: TaskFilters; view: BoardView } }[]>('/saved-views'),
    enabled: Boolean(savedViewParam),
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!savedViewParam) return;
    const list = savedViewsQuery.data;
    if (!list) return;
    const match = list.find((v) => v.id === savedViewParam);
    if (match) {
      if (match.query.filters) setFilters(match.query.filters);
      if (match.query.view) setView(match.query.view);
    }
    setSearchParams((sp) => {
      sp.delete('savedView');
      return sp;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedViewParam, savedViewsQuery.data]);

  function toggleSelect(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function clearSelection(): void {
    setSelectedIds(new Set());
  }

  // Esc clears multi-selection. The drawer also closes on Esc but it owns its
  // own listener and only fires when it's mounted, so the precedence is fine.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds.size]);

  function openTask(id: string): void {
    setSearchParams((sp) => {
      sp.set('task', id);
      return sp;
    }, { replace: false });
  }

  function closeTask(): void {
    setSearchParams((sp) => {
      sp.delete('task');
      return sp;
    }, { replace: false });
  }

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const tasksQuery = useQuery({
    queryKey: ['tasks', 'project', projectId],
    queryFn: () => api.get<Task[]>(`/tasks/project/${projectId}`),
    enabled: Boolean(projectId),
  });
  const sprintsQuery = useQuery({
    queryKey: ['sprints', projectId],
    queryFn: () => api.get<ActiveSprint[]>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId && projectQuery.data?.sprintsEnabled),
  });
  const activeSprint = (sprintsQuery.data ?? []).find((s) => s.state === 'active') ?? null;

  // Realtime: join the project room and refetch on relevant events.
  useEffect(() => {
    if (!projectId) return;
    const socket = getSocket();
    socket.emit('project:join', { projectId });
    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['tasks', 'project', projectId] });
    socket.on('task.created', invalidate);
    socket.on('task.updated', invalidate);
    socket.on('task.status_changed', invalidate);
    socket.on('task.blocked', invalidate);
    socket.on('task.unblocked', invalidate);
    socket.on('task.deleted', invalidate);
    return () => {
      socket.emit('project:leave', { projectId });
      socket.off('task.created', invalidate);
      socket.off('task.updated', invalidate);
      socket.off('task.status_changed', invalidate);
      socket.off('task.blocked', invalidate);
      socket.off('task.unblocked', invalidate);
      socket.off('task.deleted', invalidate);
    };
  }, [projectId, queryClient]);

  const tasks = tasksQuery.data ?? [];
  const project = projectQuery.data;
  const columns = useMemo(() => (project ? PRESET_STATUSES[project.workflowPreset] : []), [project]);
  const visibleTasks = useMemo(() => applyTaskFilters(tasks, filters), [tasks, filters]);
  // Children (anything with a parentTaskId — subtasks, stories under epics,
  // tasks under stories) live inside their parent card. Keep them OUT of the
  // column grouping so the board doesn't show a parent and its children side
  // by side. If the user has explicitly filtered to type=Subtask, surface them
  // (otherwise that filter would render an empty board).
  const showChildrenAsCards = filters.type === 'Subtask';
  const byStatus = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const c of columns) m.set(c, []);
    for (const t of visibleTasks) {
      if (!showChildrenAsCards && t.parentTaskId) continue;
      m.get(t.status)?.push(t);
    }
    return m;
  }, [visibleTasks, columns, showChildrenAsCards]);
  // Group every task by its parent so each card can render its subtasks inline.
  // Computed off the unfiltered task list so collapsing under filters still
  // shows the full subtask roster on each card.
  const subtasksByParent = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!t.parentTaskId) continue;
      const arr = m.get(t.parentTaskId) ?? [];
      arr.push(t);
      m.set(t.parentTaskId, arr);
    }
    return m;
  }, [tasks]);

  // ---------------------------------------------------------------------
  // Mobile swipe-to-complete / snooze handler. Fired by BoardCard pointer
  // handlers; we pick the right mutation here so the BoardCard stays
  // presentational. "Done" maps to the project's terminal status (which
  // varies by preset — Done for engineering/generic, Approved/Done for
  // design). "Snooze" pushes dueDate forward by 24h.
  // ---------------------------------------------------------------------
  const handleSwipeAction = useCallback(
    async (taskId: string, action: 'done' | 'snooze') => {
      const target = tasks.find((t) => t.id === taskId);
      if (!target) return;
      if (action === 'done') {
        const terminal = project?.workflowPreset === 'design' ? 'Approved' : 'Done';
        try {
          await api.patch(`/tasks/${taskId}/status`, { status: terminal });
          toast.success(`${target.key} marked ${terminal.toLowerCase()}`);
          void queryClient.invalidateQueries({ queryKey: ['tasks', 'project', projectId] });
        } catch (err) {
          const detail = err instanceof ApiError ? err.problem.title || err.message : 'Could not update';
          toast.error(detail);
        }
      } else {
        const base = target.dueDate ? new Date(target.dueDate) : new Date();
        const next = new Date(base.getTime() + 24 * 60 * 60 * 1000);
        try {
          await api.patch(`/tasks/${taskId}`, { dueDate: next.toISOString() });
          toast.success(`Snoozed ${target.key} 1 day`);
          void queryClient.invalidateQueries({ queryKey: ['tasks', 'project', projectId] });
        } catch (err) {
          const detail = err instanceof ApiError ? err.problem.title || err.message : 'Could not snooze';
          toast.error(detail);
        }
      }
    },
    [tasks, project?.workflowPreset, projectId, queryClient],
  );

  /**
   * Board drop handler — handles three cases in a unified flow:
   *
   *   1. Same-column reorder. Drop on another card in the same column →
   *      compute the (before, after) neighbour pair and PATCH /reorder.
   *
   *   2. Cross-column drop on a specific card. Drop on a card in a different
   *      column → set status (which the backend lands at the bottom of the
   *      new column), then PATCH /reorder to slide it next to the target.
   *
   *   3. Cross-column drop on the column body (id="col:<status>"). Same as
   *      (2) but no specific target — the card lands at the bottom and we
   *      skip the reorder call.
   *
   * The optimistic cache update reflects the final state for the visible
   * column rendering. Position is tracked via the existing `boardPosition`
   * fractional-index field; computing a local key with fractional-indexing
   * here keeps the optimistic order stable for the brief window before the
   * server response invalidates the cache.
   */
  async function onDragEnd(event: DragEndEvent): Promise<void> {
    const { active, over } = event;
    if (!over) return;

    const overId = String(over.id);
    const activeId = String(active.id);
    if (overId === activeId) return;

    const task = tasks.find((t) => t.id === activeId);
    if (!task) return;

    // Resolve destination status + target card (if any).
    let destStatus = task.status;
    let targetCard: Task | undefined;
    if (overId.startsWith('col:')) {
      destStatus = overId.slice(4);
    } else {
      targetCard = tasks.find((t) => t.id === overId);
      if (targetCard) destStatus = targetCard.status;
    }

    // Same column, same position → no-op.
    if (destStatus === task.status && !targetCard) return;
    if (destStatus === task.status && targetCard?.id === task.id) return;

    // -------- compute (before, after) neighbours in the destination column --
    //
    // We sort the destination column by boardPosition, find where the dragged
    // card should land relative to the target, and snapshot the neighbour
    // ids. `before` is the card whose boardPosition is < the new pos;
    // `after` is the one whose boardPosition is > the new pos. Either or
    // both may be null (end / start / empty column).
    const destList = tasks
      .filter((t) => t.status === destStatus && t.id !== activeId)
      .sort((a, b) => (a.boardPosition < b.boardPosition ? -1 : 1));

    let beforeId: string | null = null;
    let afterId: string | null = null;
    if (!targetCard) {
      // Drop on column body → append to bottom.
      beforeId = destList[destList.length - 1]?.id ?? null;
      afterId = null;
    } else {
      const targetIdx = destList.findIndex((t) => t.id === targetCard!.id);
      // Insert ABOVE the target (typical dnd-kit semantics on a vertical
      // sortable list).
      beforeId = destList[targetIdx - 1]?.id ?? null;
      afterId = destList[targetIdx]?.id ?? null;
    }

    // -------- optimistic local position + status update -------------------
    const beforePos = beforeId ? destList.find((t) => t.id === beforeId)?.boardPosition ?? null : null;
    const afterPos = afterId ? destList.find((t) => t.id === afterId)?.boardPosition ?? null : null;
    let newPos = task.boardPosition;
    try {
      newPos = generateKeyBetween(beforePos, afterPos);
    } catch {
      // generateKeyBetween throws if before >= after — should never happen
      // with a correctly-sorted list, but fall back to existing pos rather
      // than crash the drop.
    }

    const previousStatus = task.status;
    const previousPos = task.boardPosition;
    const queryKey = ['tasks', 'project', projectId] as const;
    // Optimistic update — mutate the dragged card AND re-sort so it lands in
    // its new slot immediately. Without the sort the card stays visually in
    // its old position until the refetch round-trip completes, which makes
    // the drop feel broken ("the order didn't change").
    //
    // Match the API's orderBy: status asc, then boardPosition asc.
    queryClient.setQueryData<Task[]>(queryKey, (old) => {
      if (!old) return old;
      return old
        .map((t) =>
          t.id === task.id ? { ...t, status: destStatus, boardPosition: newPos } : t,
        )
        .sort((a, b) => {
          if (a.status !== b.status) return a.status < b.status ? -1 : 1;
          return a.boardPosition < b.boardPosition ? -1 : 1;
        });
    });

    // Build the reorder payload. The backend's /reorder endpoint accepts
    // boardPosition fractional-index keys (NOT task IDs) — it feeds them
    // directly into generateKeyBetween() server-side. We resolved both ends
    // above. Send strings only; omit either side if it's a column edge so
    // the @IsOptional() DTO sees `undefined` rather than `null`.
    const reorderBody: { before?: string; after?: string } = {};
    if (beforePos !== null) reorderBody.before = beforePos;
    if (afterPos !== null) reorderBody.after = afterPos;

    try {
      // Same column → reorder only.
      if (destStatus === previousStatus) {
        await api.patch(`/tasks/${task.id}/reorder`, reorderBody);
      } else {
        // Cross column → status first (backend appends to bottom), then
        // reorder if the user dropped on a specific target (i.e. not the
        // very bottom of the column).
        await api.patch(`/tasks/${task.id}/status`, { status: destStatus });
        if (afterPos !== null) {
          await api.patch(`/tasks/${task.id}/reorder`, reorderBody);
        }
      }
      void queryClient.invalidateQueries({ queryKey });
    } catch (err) {
      // Roll back the optimistic update (restore prior status + position +
      // re-sort).
      queryClient.setQueryData<Task[]>(queryKey, (old) => {
        if (!old) return old;
        return old
          .map((t) =>
            t.id === task.id
              ? { ...t, status: previousStatus, boardPosition: previousPos }
              : t,
          )
          .sort((a, b) => {
            if (a.status !== b.status) return a.status < b.status ? -1 : 1;
            return a.boardPosition < b.boardPosition ? -1 : 1;
          });
      });
      const detail =
        err instanceof ApiError ? err.problem.title || err.message : 'Could not move task';
      toast.error(detail);
    }
  }

  function openCreate(status: string | null = null): void {
    setDefaultStatus(status);
    setCreateOpen(true);
  }

  // Listen for the global keyboard shortcut "c". Fires the same dialog any
  // column's + button would.
  useEffect(() => {
    const onCreate = (): void => openCreate(null);
    window.addEventListener('nockta:create-task', onCreate);
    return () => window.removeEventListener('nockta:create-task', onCreate);
  }, []);

  const bulkStatusMutation = useMutation({
    mutationFn: async ({ ids, status }: { ids: string[]; status: string }) => {
      // Chunk to 8 parallel requests at a time — keeps the API event bus from
      // getting hammered with 100+ simultaneous status-change events.
      const CHUNK = 8;
      let succeeded = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const results = await Promise.allSettled(
          batch.map((id) => api.patch(`/tasks/${id}/status`, { status })),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') succeeded++;
          else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      }
      return { succeeded, errorCount: errors.length, firstError: errors[0] };
    },
    onSuccess: ({ succeeded, errorCount, firstError }) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'project', projectId] });
      clearSelection();
      if (errorCount === 0) {
        toast.success(`Moved ${succeeded} task${succeeded === 1 ? '' : 's'}`);
      } else {
        toast.error(`Moved ${succeeded}, ${errorCount} failed${firstError ? ` — ${firstError}` : ''}`);
      }
    },
  });

  // Bulk-patch helper: runs the same PATCH body across every selected task,
  // chunked, invalidates, and reports.
  const bulkPatch = useMutation({
    mutationFn: async ({ ids, body, label }: { ids: string[]; body: Record<string, unknown>; label: string }) => {
      const CHUNK = 8;
      let succeeded = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const results = await Promise.allSettled(
          batch.map((id) => api.patch(`/tasks/${id}`, body)),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') succeeded++;
          else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      }
      return { succeeded, errorCount: errors.length, firstError: errors[0], label };
    },
    onSuccess: ({ succeeded, errorCount, firstError, label }) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'project', projectId] });
      clearSelection();
      if (errorCount === 0) {
        toast.success(`${label}: ${succeeded} task${succeeded === 1 ? '' : 's'}`);
      } else {
        toast.error(`${label}: ${succeeded} ok, ${errorCount} failed${firstError ? ` — ${firstError}` : ''}`);
      }
    },
  });

  // Bulk label op — attach or detach a single label to/from every selected
  // task. We treat 409 (label already on task / not on task) as success so a
  // user can fire "attach Backend" against a mixed set without partial errors.
  const bulkLabel = useMutation({
    mutationFn: async ({
      ids,
      labelId,
      mode,
    }: {
      ids: string[];
      labelId: string;
      mode: 'attach' | 'detach';
    }) => {
      const CHUNK = 8;
      let succeeded = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const results = await Promise.allSettled(
          batch.map((id) =>
            mode === 'attach'
              ? api.post(`/tasks/${id}/labels/${labelId}`, {})
              : api.delete(`/tasks/${id}/labels/${labelId}`),
          ),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            succeeded++;
          } else {
            const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
            // Idempotent semantics: already-attached / already-detached counts as success.
            if (/already|not found|conflict|409/i.test(msg)) succeeded++;
            else errors.push(msg);
          }
        }
      }
      return { succeeded, errorCount: errors.length, firstError: errors[0], mode };
    },
    onSuccess: ({ succeeded, errorCount, firstError, mode }) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'project', projectId] });
      clearSelection();
      const verb = mode === 'attach' ? 'Labeled' : 'Unlabeled';
      if (errorCount === 0) {
        toast.success(`${verb}: ${succeeded} task${succeeded === 1 ? '' : 's'}`);
      } else {
        toast.error(
          `${verb}: ${succeeded} ok, ${errorCount} failed${firstError ? ` — ${firstError}` : ''}`,
        );
      }
    },
  });

  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      const CHUNK = 8;
      let succeeded = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const results = await Promise.allSettled(batch.map((id) => api.delete(`/tasks/${id}`)));
        for (const r of results) {
          if (r.status === 'fulfilled') succeeded++;
          else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      }
      return { succeeded, errorCount: errors.length, firstError: errors[0] };
    },
    onSuccess: ({ succeeded, errorCount, firstError }) => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'project', projectId] });
      clearSelection();
      if (errorCount === 0) {
        toast.success(`Deleted ${succeeded} task${succeeded === 1 ? '' : 's'}`);
      } else {
        toast.error(`Deleted ${succeeded}, ${errorCount} failed${firstError ? ` — ${firstError}` : ''}`);
      }
    },
  });

  // Pull-to-refresh: triggers a re-fetch of the board's tasks + sprints
  // when the user drags down past the threshold on a touch device. Wired
  // to the inner scroll container below.
  //
  // IMPORTANT: this hook MUST sit before the early returns below — otherwise
  // the first render (project still loading) calls fewer hooks than the
  // second (project loaded), which trips React's hook-order invariant and
  // throws "Rendered more hooks than during the previous render."
  const pull = usePullToRefresh({
    onRefresh: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks', 'project', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['sprints', projectId] }),
      ]);
    },
  });

  if (projectQuery.isError) {
    return (
      <QueryErrorState
        title="Couldn't load this project"
        error={projectQuery.error}
        onRetry={() => void projectQuery.refetch()}
        className="py-16"
      />
    );
  }
  if (!project) {
    return (
      <div className="p-8 text-sm text-muted-foreground flex items-center gap-2">
        <Spinner /> Loading project…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Slim header — project identity only. Backlog/Docs/Automations/Settings
          moved into the ProjectTabs strip below so nav lives in one place. */}
      <header className="px-4 sm:px-6 md:px-8 py-3 sm:py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">
            {project.key}
          </span>
          <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate">{project.name}</h1>
          <PresenceAvatars room={`project:${project.id}`} size={22} />
        </div>
        <div className="hidden md:flex items-center gap-2">
          {projectId && <TemplatesQuickCreate projectId={projectId} />}
        </div>
      </header>

      {/* Unified project nav — Board/List/Backlog/Timeline/Docs/Automations as
          tabs, Settings as a trailing gear icon, action buttons on the right
          edge. One row, one mental model. */}
      <ProjectTabs
        projectId={projectId ?? ''}
        actions={
          <>
            {standupOpen ? (
              <button
                type="button"
                onClick={() => setStandupOpen(false)}
                className="tap inline-flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand/15 px-3 h-8 text-xs font-medium text-brand hover:bg-brand/20 transition-colors"
                title="End standup (Esc)"
              >
                <Sun className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">End standup</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setStandupOpen(true)}
                className="tap inline-flex items-center gap-1.5 rounded-md border border-border px-3 h-8 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                title="Start a team standup"
              >
                <Play className="h-3 w-3" />
                <span className="hidden sm:inline">{t('project_board.start_standup', 'Start standup')}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => openCreate(null)}
              className="tap rounded-md bg-primary px-3 sm:px-4 h-8 text-xs sm:text-sm font-medium text-primary-foreground hover:opacity-90 transition-[opacity,transform] duration-150"
            >
              <span className="sm:hidden">+</span>
              <span className="hidden sm:inline">{t('project_board.new_task', 'New task')}</span>
            </button>
          </>
        }
      />

      {activeSprint && (
        <div className="px-4 sm:px-6 md:px-8 py-2 border-b border-border bg-brand/10 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 nockta-eyebrow text-brand">
                <span className="h-2 w-2 rounded-full bg-brand animate-pulse" />
                Active sprint
              </span>
              <span className="text-sm font-semibold">{activeSprint.name}</span>
              {(activeSprint.startDate || activeSprint.endDate) && (
                <span className="text-xs text-muted-foreground">
                  {activeSprint.startDate
                    ? new Date(activeSprint.startDate).toLocaleDateString()
                    : '—'}
                  {' → '}
                  {activeSprint.endDate
                    ? new Date(activeSprint.endDate).toLocaleDateString()
                    : '—'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {filters.sprintId === activeSprint.id ? (
                <button
                  type="button"
                  onClick={() => {
                    const { sprintId: _drop, ...rest } = filters;
                    setFilters(rest);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Show all tasks
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setFilters({ ...filters, sprintId: activeSprint.id })}
                  className="tap rounded-md bg-brand px-3 py-1 text-xs font-medium text-brand-foreground hover:opacity-90 transition-[opacity,transform] duration-150"
                >
                  Sprint board →
                </button>
              )}
            </div>
          </div>
          {activeSprint.goal && (
            <p
              className="text-xs text-foreground/80 italic truncate"
              title={activeSprint.goal}
            >
              &ldquo;{activeSprint.goal}&rdquo;
            </p>
          )}
        </div>
      )}

      <BoardToolbar
        view={view}
        onViewChange={setView}
        filters={filters}
        onFiltersChange={setFilters}
        taskCount={visibleTasks.length}
        sprintsEnabled={project.sprintsEnabled ?? false}
        tasks={tasks}
        {...(projectId ? { projectId } : {})}
      />

      {/* When standup mode is on, the runner sits as a fixed-width leftmost
          column; the board (or list) scrolls inside the remaining space. */}
      <PullIndicator state={pull} />
      <div ref={pull.ref} className="flex-1 flex min-h-0 overflow-hidden">
        {standupOpen && (
          <StandupRunner
            tasks={tasks}
            onClose={() => setStandupOpen(false)}
            onSpeakerChange={handleSpeakerChange}
          />
        )}
        {view === 'board' ? (
          <BoardCanvas
            columns={columns}
            byStatus={byStatus}
            subtasksByParent={subtasksByParent}
            selectedIds={selectedIds}
            toggleSelect={toggleSelect}
            onAdd={openCreate}
            onOpen={openTask}
            onDragEnd={onDragEnd}
            sensors={sensors}
            isMobile={isMobile}
            mobileColumnIdx={mobileColumnIdx}
            setMobileColumnIdx={setMobileColumnIdx}
            onSwipeAction={handleSwipeAction}
          />
        ) : (
          <div className="flex-1 overflow-auto">
            <ProjectListView
              project={project}
              tasks={visibleTasks}
              filters={{ ...filters, search: '' }}
              onOpenTask={openTask}
              onAddTask={openCreate}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
            />
          </div>
        )}
      </div>
      {createOpen && project && (
        <CreateTaskDialog
          project={project}
          defaultStatus={defaultStatus}
          onClose={() => setCreateOpen(false)}
        />
      )}
      {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />}
      {selectedIds.size > 0 && (
        <BulkActionBar
          count={selectedIds.size}
          statuses={columns}
          projectId={projectId ?? ''}
          sprintsEnabled={Boolean(project?.sprintsEnabled)}
          pending={
            bulkStatusMutation.isPending ||
            bulkPatch.isPending ||
            bulkDelete.isPending ||
            bulkLabel.isPending
          }
          onLabel={(labelId, mode) =>
            bulkLabel.mutate({ ids: Array.from(selectedIds), labelId, mode })
          }
          onMove={(status) =>
            bulkStatusMutation.mutate({ ids: Array.from(selectedIds), status })
          }
          onAssign={(assigneeUserId) =>
            bulkPatch.mutate({
              ids: Array.from(selectedIds),
              body: { assigneeUserId },
              label: assigneeUserId === null ? 'Unassigned' : 'Assigned',
            })
          }
          onPriority={(priority) =>
            bulkPatch.mutate({
              ids: Array.from(selectedIds),
              body: { priority },
              label: `Priority → ${priority}`,
            })
          }
          onSprint={(sprintId) =>
            bulkPatch.mutate({
              ids: Array.from(selectedIds),
              body: { sprintId },
              label: sprintId === null ? 'Moved to backlog' : 'Moved to sprint',
            })
          }
          onDelete={() => {
            if (window.confirm(`Delete ${selectedIds.size} task${selectedIds.size === 1 ? '' : 's'}? This cannot be undone.`)) {
              bulkDelete.mutate(Array.from(selectedIds));
            }
          }}
          onClear={clearSelection}
        />
      )}
    </div>
  );
}

// ============================================================================
// TemplatesQuickCreate — header dropdown for quick-creating from a template.
// ============================================================================

interface TaskTemplate {
  id: string;
  name: string;
  description: string | null;
  titleTemplate: string;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
}

function TemplatesQuickCreate({ projectId }: { projectId: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const templatesQuery = useQuery({
    queryKey: ['task-templates', projectId],
    queryFn: () => api.get<TaskTemplate[]>(`/projects/${projectId}/task-templates`),
  });
  const instantiate = useMutation({
    mutationFn: (id: string) => api.post(`/task-templates/${id}/instantiate`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
      toast.success('Task created from template');
      setOpen(false);
    },
    onError: () => toast.error('Could not create from template'),
  });
  const templates = templatesQuery.data ?? [];
  if (templates.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="tap inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <FileText className="h-3.5 w-3.5" />
        Templates
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
            className="animate-popover-in absolute right-0 top-full z-40 mt-1 w-64 rounded-lg border border-border bg-popover shadow-xl"
            style={{ transformOrigin: 'top right' }}
          >
            <header className="border-b border-border px-3 py-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Task templates
            </header>
            <ul className="max-h-72 overflow-y-auto stagger-list">
              {templates.map((t) => (
                <li key={t.id} className="stagger-item">
                  <button
                    type="button"
                    onClick={() => instantiate.mutate(t.id)}
                    className="tap w-full px-3 py-2 text-left text-sm hover:bg-muted/60 transition-colors"
                  >
                    <div className="font-medium">{t.name}</div>
                    {t.description && <div className="text-[11px] text-muted-foreground line-clamp-1">{t.description}</div>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function BulkActionBar({
  count,
  statuses,
  projectId,
  sprintsEnabled,
  pending,
  onMove,
  onAssign,
  onPriority,
  onSprint,
  onLabel,
  onDelete,
  onClear,
}: {
  count: number;
  statuses: string[];
  projectId: string;
  sprintsEnabled: boolean;
  pending: boolean;
  onMove: (status: string) => void;
  onAssign: (assigneeUserId: string | null) => void;
  onPriority: (priority: Priority) => void;
  onSprint: (sprintId: string | null) => void;
  /** Attach or detach one label across every selected task. Mode is encoded
   *  in the dropdown's value (e.g. `attach:<id>` / `detach:<id>`). */
  onLabel: (labelId: string, mode: 'attach' | 'detach') => void;
  onDelete: () => void;
  onClear: () => void;
}): JSX.Element {
  const usersQuery = useQuery({
    queryKey: ['users', 'list'],
    queryFn: () => api.get<{ items: User[]; nextCursor: string | null }>('/users?limit=100'),
  });
  const sprintsQuery = useQuery({
    queryKey: ['sprints', projectId],
    queryFn: () => api.get<Array<{ id: string; name: string; state: 'planned' | 'active' | 'completed' }>>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId && sprintsEnabled),
  });
  const labelsQuery = useQuery({
    queryKey: ['labels', projectId],
    queryFn: () => api.get<Array<{ id: string; name: string; color: string }>>(`/projects/${projectId}/labels`),
    enabled: Boolean(projectId),
  });
  const users = usersQuery.data?.items ?? [];
  const sprints = (sprintsQuery.data ?? []).filter((s) => s.state !== 'completed');
  const labels = labelsQuery.data ?? [];

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 animate-popover-in" style={{ transformOrigin: 'bottom center' }}>
      <div className="flex items-center gap-2 rounded-lg bg-card border border-border shadow-xl px-3 py-2 flex-wrap max-w-[min(96vw,900px)]">
        <span className="text-sm font-medium">{count} selected</span>
        <span className="text-muted-foreground text-xs">·</span>

        {/* Status */}
        <BulkSelect
          label="Status"
          disabled={pending}
          onChange={(v) => v && onMove(v)}
          options={[{ value: '', label: '—' }, ...statuses.map((s) => ({ value: s, label: s }))]}
        />

        {/* Priority */}
        <BulkSelect
          label="Priority"
          disabled={pending}
          onChange={(v) => v && onPriority(v as Priority)}
          options={[
            { value: '', label: '—' },
            { value: 'Critical', label: 'Critical' },
            { value: 'High', label: 'High' },
            { value: 'Medium', label: 'Medium' },
            { value: 'Low', label: 'Low' },
          ]}
        />

        {/* Assignee */}
        <BulkSelect
          label="Assignee"
          disabled={pending}
          onChange={(v) => {
            if (v === '') return;
            onAssign(v === '__unassign' ? null : v);
          }}
          options={[
            { value: '', label: '—' },
            { value: '__unassign', label: 'Unassign' },
            ...users.map((u) => ({ value: u.id, label: u.name || u.email })),
          ]}
        />

        {/* Sprint */}
        {sprintsEnabled && (
          <BulkSelect
            label="Sprint"
            disabled={pending}
            onChange={(v) => {
              if (v === '') return;
              onSprint(v === '__backlog' ? null : v);
            }}
            options={[
              { value: '', label: '—' },
              { value: '__backlog', label: 'Move to backlog' },
              ...sprints.map((s) => ({ value: s.id, label: `${s.name} (${s.state})` })),
            ]}
          />
        )}

        {/* Labels — single select with attach/detach prefix on the option value.
            Splitting into two adjacent selects would double the bar's width;
            this keeps it compact while still letting the user remove a label
            from a selection. */}
        {labels.length > 0 && (
          <BulkSelect
            label="Labels"
            disabled={pending}
            onChange={(v) => {
              if (!v) return;
              const [mode, id] = v.split(':');
              if ((mode === 'attach' || mode === 'detach') && id) {
                onLabel(id, mode);
              }
            }}
            options={[
              { value: '', label: '—' },
              ...labels.map((l) => ({ value: `attach:${l.id}`, label: `+ ${l.name}` })),
              ...labels.map((l) => ({ value: `detach:${l.id}`, label: `− ${l.name}` })),
            ]}
          />
        )}

        {/* Delete */}
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          className="tap rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
        >
          Delete
        </button>

        <button
          type="button"
          onClick={onClear}
          disabled={pending}
          aria-label="Clear selection"
          className="tap ml-1 rounded-md w-7 h-7 flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * Renders up to 2 custom-field chips on a board card. Sorted by `position`
 * so the user-defined order is respected. Skips fields whose value is empty.
 */
function CustomFieldChips({ values }: { values: CustomFieldValue[] }): JSX.Element | null {
  const visible = [...values]
    .sort((a, b) => a.field.position - b.field.position)
    .filter((v) => !isEmptyFieldValue(v))
    .slice(0, 2);
  if (visible.length === 0) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
      {visible.map((v) => (
        <span
          key={v.id}
          title={v.field.name}
          className="inline-flex items-center gap-1 rounded bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          <span className="font-medium text-foreground/80">{v.field.name}:</span>
          <span>{formatFieldValue(v)}</span>
        </span>
      ))}
    </div>
  );
}

function isEmptyFieldValue(v: CustomFieldValue): boolean {
  const val = v.value;
  if (val === null || val === undefined || val === '') return true;
  if (Array.isArray(val) && val.length === 0) return true;
  return false;
}

function formatFieldValue(v: CustomFieldValue): string {
  const val = v.value;
  switch (v.field.kind) {
    case 'select': {
      const opt = v.field.options.find((o) => o.value === val);
      return opt?.label ?? String(val);
    }
    case 'multiselect': {
      if (!Array.isArray(val)) return '';
      return (val as string[])
        .map((id) => v.field.options.find((o) => o.value === id)?.label ?? id)
        .join(', ');
    }
    case 'checkbox':
      return val ? '✓' : '·';
    case 'date':
      return typeof val === 'string' ? new Date(val).toLocaleDateString() : '';
    case 'number':
      return String(val);
    case 'url':
      try {
        return new URL(String(val)).host;
      } catch {
        return String(val);
      }
    default:
      return String(val).slice(0, 40);
  }
}

/**
 * Inline select used inside the BulkActionBar. Fires onChange on every pick,
 * resetting to '' after so a second pick of the same option still triggers.
 */
function BulkSelect({
  label,
  options,
  disabled,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="relative inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs cursor-pointer hover:bg-accent transition-colors">
      <span className="text-muted-foreground">{label}</span>
      <select
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v);
          e.target.value = '';
        }}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// =============================================================================
// BoardCanvas — branches between the desktop multi-column grid and the mobile
// single-column carousel. Same DndContext, same BoardColumn children — only
// the wrapper differs.
//
// Mobile carousel notes:
//   - One column visible at a time. Arrow buttons + dot strip up top; touch
//     swipe (>=40px horizontal, < ~30deg vertical) advances by one column.
//   - Drag-and-drop INSIDE the visible column still works because the
//     SortableContext for that column is fully mounted. CROSS-column drag is
//     intentionally disabled on mobile — there's no neighbour column rendered
//     to drop onto, and chasing carousel navigation mid-drag is fiddlier than
//     it's worth. Users that need to move a card across columns can either
//     rotate landscape (>=md) or use the task drawer's status field.
// =============================================================================
interface BoardCanvasProps {
  columns: string[];
  byStatus: Map<string, Task[]>;
  subtasksByParent: Map<string, Task[]>;
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  onAdd: (status: string | null) => void;
  onOpen: (id: string) => void;
  onDragEnd: (event: DragEndEvent) => void;
  sensors: ReturnType<typeof useSensors>;
  isMobile: boolean;
  mobileColumnIdx: number;
  setMobileColumnIdx: (idx: number | ((prev: number) => number)) => void;
  onSwipeAction: (taskId: string, action: 'done' | 'snooze') => void;
}

function BoardCanvas(props: BoardCanvasProps): JSX.Element {
  const {
    columns, byStatus, subtasksByParent, selectedIds, toggleSelect,
    onAdd, onOpen, onDragEnd, sensors,
    isMobile, mobileColumnIdx, setMobileColumnIdx, onSwipeAction,
  } = props;

  // -------------------------------------------------------------------------
  // Drag overlay — render a portal-mounted snapshot of the dragged card so
  // it floats above every column (and outside their `overflow-y-auto`
  // clipping context). Without this, the in-place card transforms inside its
  // origin column and gets stacked beneath sibling columns mid-drag.
  // -------------------------------------------------------------------------
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  function handleDragStart(e: DragStartEvent): void {
    for (const list of byStatus.values()) {
      const found = list.find((t) => t.id === e.active.id);
      if (found) {
        setActiveTask(found);
        return;
      }
    }
  }
  function handleDragEnd(e: DragEndEvent): void {
    setActiveTask(null);
    onDragEnd(e);
  }
  function handleDragCancel(): void {
    setActiveTask(null);
  }

  // Clamp the mobile index if columns shrink (shouldn't happen at runtime, but
  // defensive). Wrapped in an effect so we don't setState during render.
  useEffect(() => {
    if (mobileColumnIdx >= columns.length && columns.length > 0) {
      setMobileColumnIdx(columns.length - 1);
    }
  }, [columns.length, mobileColumnIdx, setMobileColumnIdx]);

  // Touch tracking — keep both X and Y so we can ignore swipes that are
  // dominantly vertical (the user is scrolling the column, not paging).
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  function onTouchStart(e: React.TouchEvent): void {
    const t = e.changedTouches[0];
    if (!t) return;
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  }
  function onTouchEnd(e: React.TouchEvent): void {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx)) return;
    if (dx < 0) {
      setMobileColumnIdx((i) => Math.min(columns.length - 1, i + 1));
    } else {
      setMobileColumnIdx((i) => Math.max(0, i - 1));
    }
  }

  // Keyboard nav on mobile (when a card has focus, ←/→ pages). Arrow keys are
  // captured at the canvas root so the user doesn't need to focus a specific
  // element first.
  function onKeyDown(e: React.KeyboardEvent): void {
    if (!isMobile) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setMobileColumnIdx((i) => Math.min(columns.length - 1, i + 1));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setMobileColumnIdx((i) => Math.max(0, i - 1));
    }
  }

  if (isMobile) {
    const safeIdx = Math.min(Math.max(0, mobileColumnIdx), Math.max(0, columns.length - 1));
    const visibleCol = columns[safeIdx];
    return (
      <div
        className="flex-1 flex flex-col min-h-0"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        {/* Dot strip + arrow controls */}
        <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 bg-card/30">
          <button
            type="button"
            onClick={() => setMobileColumnIdx((i) => Math.max(0, i - 1))}
            disabled={safeIdx === 0}
            aria-label="Previous column"
            className="tap inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex-1 flex items-center justify-center gap-1.5" role="tablist" aria-label="Board columns">
            {columns.map((col, i) => (
              <button
                key={col}
                type="button"
                role="tab"
                aria-selected={i === safeIdx}
                aria-label={col}
                onClick={() => setMobileColumnIdx(i)}
                className={cn(
                  'tap h-2 rounded-full transition-all',
                  i === safeIdx ? 'w-6 bg-foreground' : 'w-2 bg-muted-foreground/40 hover:bg-muted-foreground/70',
                )}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() =>
              setMobileColumnIdx((i) => Math.min(columns.length - 1, i + 1))
            }
            disabled={safeIdx === columns.length - 1}
            aria-label="Next column"
            className="tap inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {visibleCol && (
            <DndContext
              sensors={sensors}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <BoardColumn
                key={visibleCol}
                status={visibleCol}
                tasks={byStatus.get(visibleCol) ?? []}
                subtasksByParent={subtasksByParent}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onAdd={() => onAdd(visibleCol)}
                onOpen={onOpen}
                isMobile={isMobile}
                onSwipeAction={onSwipeAction}
              />
              <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
                {activeTask ? <DragOverlayCard task={activeTask} /> : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>
    );
  }

  // Desktop: multi-column grid. The container scrolls horizontally only when
  // there are more columns than fit — this is the kanban exception the audit
  // explicitly allows.
  return (
    <div className="flex-1 overflow-x-auto p-3 sm:p-4 md:p-6">
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="grid grid-flow-col auto-cols-[minmax(280px,1fr)] gap-4 h-full">
          {columns.map((col) => (
            <BoardColumn
              key={col}
              status={col}
              tasks={byStatus.get(col) ?? []}
              subtasksByParent={subtasksByParent}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onAdd={() => onAdd(col)}
              onOpen={onOpen}
              isMobile={isMobile}
              onSwipeAction={onSwipeAction}
            />
          ))}
        </div>
        {/* Portal-rendered floating card. Sits above all columns regardless of
            their stacking context / overflow clipping. */}
        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
          {activeTask ? <DragOverlayCard task={activeTask} /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

/**
 * DragOverlayCard — visual-only snapshot of a BoardCard rendered into the
 * dnd-kit DragOverlay portal. No sortable hooks, no swipe handlers, no
 * checkbox; just the look. Mirrors BoardCard's outer chrome (border, padding,
 * shadow) so the floating element matches what the user grabbed.
 *
 * We bump the shadow + add a slight rotate so the card visibly "lifts" off
 * the board the way Jira / Linear do.
 */
function DragOverlayCard({ task }: { task: Task }): JSX.Element {
  return (
    <div
      className="board-card relative rounded-md border bg-card p-3 shadow-2xl ring-1 ring-primary/20 border-border cursor-grabbing"
      style={{ transform: 'rotate(2deg)', width: 280 }}
    >
      <div className="flex items-start gap-2 mb-2">
        <span className="text-[10px] font-mono text-muted-foreground">{task.key}</span>
        {task.priority && <PriorityDot priority={task.priority as Priority} />}
        {task.isBlocked && <BlockedBadge blocked />}
      </div>
      <div className="text-sm font-medium leading-snug line-clamp-3">{task.title}</div>
      {(task.dueDate || task.assignee) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {task.dueDate ? <DueDateChip dueDate={task.dueDate} /> : <span />}
          {task.assignee && <AvatarCircle user={task.assignee} size={20} />}
        </div>
      )}
    </div>
  );
}

function BoardColumn({
  status,
  tasks,
  subtasksByParent,
  selectedIds,
  onToggleSelect,
  onAdd,
  onOpen,
  isMobile,
  onSwipeAction,
}: {
  status: string;
  tasks: Task[];
  subtasksByParent: Map<string, Task[]>;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onAdd: () => void;
  onOpen: (id: string) => void;
  isMobile: boolean;
  onSwipeAction: (taskId: string, action: 'done' | 'snooze') => void;
}): JSX.Element {
  // Register the column body as a drop target so dropping anywhere in the
  // column (not just onto a task) triggers a status change. Without this,
  // @dnd-kit only sees the per-task Sortable drops.
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });

  // Virtualization — only kicks in when there are more than 50 cards in a
  // single column. Below the threshold the cost of the offset / total-size
  // math isn't worth it (and breaks the auto-stagger of the entry animation).
  // The scroll container is the column body itself (`scrollRef`).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = tasks.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? tasks.length : 0,
    estimateSize: () => ESTIMATED_CARD_HEIGHT,
    getScrollElement: () => scrollRef.current,
    overscan: 5,
  });

  // Compose the dnd-kit droppable ref with our local scroll ref so both
  // systems see the same node.
  const composeRef = (node: HTMLDivElement | null): void => {
    setNodeRef(node);
    scrollRef.current = node;
  };

  return (
    <div className="rounded-lg bg-secondary/30 flex flex-col">
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <StatusPill status={status} />
          <span className="text-xs text-muted-foreground font-mono">{tasks.length}</span>
        </div>
        <button
          type="button"
          onClick={onAdd}
          aria-label={`Add task to ${status}`}
          className="tap rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={composeRef}
          className="board-column-body p-2 flex-1 min-h-[200px] rounded-b-lg overflow-y-auto"
          data-status={status}
          data-over={isOver ? 'true' : 'false'}
        >
          {shouldVirtualize ? (
            // Spacer div claims the total list height so the scrollbar reflects
            // the full collection; absolute-positioned cards float inside.
            <div
              style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
              data-virtualized="true"
            >
              {virtualizer.getVirtualItems().map((v) => {
                const t = tasks[v.index];
                if (!t) return null;
                return (
                  <div
                    key={t.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${v.start}px)`,
                      padding: '0 0 8px 0',
                    }}
                  >
                    <BoardCard
                      task={t}
                      subtasks={subtasksByParent.get(t.id) ?? []}
                      selected={selectedIds.has(t.id)}
                      onToggleSelect={() => onToggleSelect(t.id)}
                      onOpen={() => onOpen(t.id)}
                      isMobile={isMobile}
                      onSwipeAction={onSwipeAction}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-2">
              {tasks.map((t) => (
                <BoardCard
                  key={t.id}
                  task={t}
                  subtasks={subtasksByParent.get(t.id) ?? []}
                  selected={selectedIds.has(t.id)}
                  onToggleSelect={() => onToggleSelect(t.id)}
                  onOpen={() => onOpen(t.id)}
                  isMobile={isMobile}
                  onSwipeAction={onSwipeAction}
                />
              ))}
              <button
                type="button"
                onClick={onAdd}
                className="tap w-full text-left text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-md px-2 py-1.5 transition-colors"
              >
                + Add task
              </button>
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

function BoardCard({
  task,
  subtasks,
  selected,
  onToggleSelect,
  onOpen,
  isMobile,
  onSwipeAction,
}: {
  task: Task;
  subtasks: Task[];
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  isMobile: boolean;
  onSwipeAction: (taskId: string, action: 'done' | 'snooze') => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const [subtasksOpen, setSubtasksOpen] = useState(false);
  const subtaskCount = subtasks.length;
  const subtasksDone = subtasks.filter((s) => s.status.toLowerCase() === 'done' || s.status === 'Approved').length;

  // -------------------------------------------------------------------------
  // Swipe-to-complete / snooze — mobile only.
  //
  // The card is draggable both by dnd-kit (for column moves) and by our own
  // pointer handlers (for swipe gestures). We resolve the conflict on the fly:
  // once we've moved >= 5px, we look at the dominant axis. Horizontal motion
  // claims the swipe, vertical hands off to dnd-kit (which itself only kicks
  // in past distance:5 — our PointerSensor activationConstraint).
  //
  // Threshold is 80px in either direction; under that the card snaps back.
  // We track the live offset in state so the card visibly follows the finger
  // and a coloured reveal (green check / amber clock) shows underneath.
  // -------------------------------------------------------------------------
  const swipeStartRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const [swipeDx, setSwipeDx] = useState(0);
  // 'claimed' = our gesture owns this drag; 'released' = handed off to dnd-kit;
  // null = undecided.
  const swipeMode = useRef<'claimed' | 'released' | null>(null);
  const SWIPE_THRESHOLD = 80;
  const SWIPE_REVEAL_TRIGGER = 5;

  const swipeHandlers = isMobile
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          // Ignore clicks on the embedded interactive controls — they need to
          // claim their own pointer events (checkbox, subtask toggle).
          const target = e.target as HTMLElement;
          if (target.closest('input, [role="checkbox"], button[aria-expanded]')) return;
          swipeStartRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          swipeMode.current = null;
          setSwipeDx(0);
        },
        onPointerMove: (e: React.PointerEvent) => {
          const start = swipeStartRef.current;
          if (!start || start.id !== e.pointerId) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (swipeMode.current === null) {
            // Decide once movement exceeds the disambiguation threshold.
            if (Math.abs(dx) < SWIPE_REVEAL_TRIGGER && Math.abs(dy) < SWIPE_REVEAL_TRIGGER) return;
            if (isHorizontalDominant({ dx, dy })) {
              swipeMode.current = 'claimed';
              try {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              } catch {
                // setPointerCapture can throw if the pointer was already
                // captured by dnd-kit; that's fine — we'll just track via
                // pointermove on the document instead.
              }
            } else {
              swipeMode.current = 'released';
              return;
            }
          }
          if (swipeMode.current === 'claimed') {
            // Cap the visual offset so the card doesn't drag off-screen and
            // the user gets clear "this is the threshold" feedback.
            setSwipeDx(Math.max(-160, Math.min(160, dx)));
          }
        },
        onPointerUp: (e: React.PointerEvent) => {
          const start = swipeStartRef.current;
          swipeStartRef.current = null;
          if (!start || start.id !== e.pointerId) {
            setSwipeDx(0);
            swipeMode.current = null;
            return;
          }
          if (swipeMode.current === 'claimed') {
            const dx = e.clientX - start.x;
            if (dx > SWIPE_THRESHOLD) {
              onSwipeAction(task.id, 'done');
            } else if (dx < -SWIPE_THRESHOLD) {
              onSwipeAction(task.id, 'snooze');
            }
          }
          setSwipeDx(0);
          swipeMode.current = null;
        },
        onPointerCancel: () => {
          swipeStartRef.current = null;
          swipeMode.current = null;
          setSwipeDx(0);
        },
      }
    : {};

  // PointerSensor has activationConstraint distance:5, so a plain click never
  // triggers a drag — we can safely put onClick on the card itself.
  const cardTransform = swipeDx
    ? `${CSS.Transform.toString(transform) ?? ''} translateX(${swipeDx}px)`.trim()
    : CSS.Transform.toString(transform);

  return (
    <div className="relative" {...swipeHandlers}>
      {/* Swipe reveal — green check on the right (done), amber clock on the
          left (snooze). Only rendered when there's a meaningful swipe in
          progress so it doesn't add to the painted layers in the idle state. */}
      {isMobile && Math.abs(swipeDx) > SWIPE_REVEAL_TRIGGER && (
        <div
          aria-hidden="true"
          className={cn(
            'absolute inset-0 rounded-md flex items-center px-4 text-sm font-medium pointer-events-none',
            swipeDx > 0
              ? 'justify-start bg-status-done/20 text-status-done'
              : 'justify-end bg-amber-500/20 text-amber-600 dark:text-amber-300',
          )}
          data-testid={`swipe-reveal-${task.id}`}
        >
          {swipeDx > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" />
              {Math.abs(swipeDx) >= SWIPE_THRESHOLD ? 'Mark done' : 'Swipe to complete'}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {Math.abs(swipeDx) >= SWIPE_THRESHOLD ? 'Snooze 1 day' : 'Swipe to snooze'}
              <Clock className="h-4 w-4" />
            </span>
          )}
        </div>
      )}
    <div
      ref={setNodeRef}
      style={{
        ...style,
        transform: cardTransform,
        transition: swipeDx ? 'none' : transition,
        // While dragging, hide the in-place card — the DragOverlay portal
        // renders the floating copy. Keep the space occupied (opacity 0,
        // pointer-events none) so the column layout doesn't jump.
        opacity: isDragging ? 0 : 1,
        pointerEvents: isDragging ? 'none' : undefined,
      }}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      data-dragging={isDragging ? 'true' : 'false'}
      className={cn(
        'board-card group relative rounded-md border bg-card p-3 cursor-pointer shadow-sm',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-ring hover:shadow-md',
      )}
    >
      <label
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(
          'absolute top-2 right-2 flex items-center justify-center z-10',
          'transition-opacity',
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${task.key}`}
          className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
        />
      </label>

      {/* Top row — type + key (left) + priority dot (right) */}
      <div className="flex items-center justify-between gap-2 pr-6">
        <span className="flex items-center gap-1.5 min-w-0">
          <TypeBadge type={task.type ?? 'Task'} />
          <span className="text-[11px] font-mono text-muted-foreground truncate">{task.key}</span>
        </span>
        <PriorityDot priority={task.priority} />
      </div>

      {/* Title */}
      <div className="text-sm mt-1.5 font-medium leading-snug text-foreground line-clamp-2">
        {task.title}
      </div>

      {/* Chip row — blocked, at-risk, due date */}
      {(task.isBlocked || task.aiRiskReason || task.dueDate) && (
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <BlockedBadge blocked={task.isBlocked} />
          <AtRiskBadge reason={task.aiRiskReason} />
          <DueDateChip dueDate={task.dueDate} done={task.status === 'Done'} />
        </div>
      )}

      {/* Label chips — colored pills below the title so they're visible at a
          glance. Show up to 3; overflow into a "+N" indicator so a heavily
          tagged card doesn't take over the row. */}
      {task.labels && task.labels.length > 0 && (
        <div className="flex items-center gap-1 mt-2 flex-wrap">
          {task.labels.slice(0, 3).map(({ label: l }) => {
            const hex = l.color.startsWith('#') ? l.color : `#${l.color}`;
            return (
              <span
                key={l.id}
                className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium"
                style={{
                  backgroundColor: `${hex}22`,
                  color: hex,
                  border: `1px solid ${hex}44`,
                }}
                title={l.name}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: hex }}
                  aria-hidden="true"
                />
                <span className="truncate max-w-[100px]">{l.name}</span>
              </span>
            );
          })}
          {task.labels.length > 3 && (
            <span className="text-[10px] text-muted-foreground">+{task.labels.length - 3}</span>
          )}
        </div>
      )}

      {/* Custom field chips — show the first two non-empty values so the card
          stays compact. Hover the name to see the full label. */}
      {task.customFieldValues && task.customFieldValues.length > 0 && (
        <CustomFieldChips values={task.customFieldValues} />
      )}

      {/* Bottom row — assignee avatar + subtask toggle */}
      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-border/60 text-xs text-muted-foreground">
        {task.assignee ? (
          <span className="flex items-center gap-1.5 min-w-0">
            <AvatarCircle user={task.assignee} size={20} />
            <span className="truncate">{task.assignee.name}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-muted-foreground/60">
            <AvatarCircle user={null} size={20} />
            Unassigned
          </span>
        )}
        {subtaskCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSubtasksOpen((o) => !o);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="tap inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-expanded={subtasksOpen}
            aria-label={`${subtasksOpen ? 'Hide' : 'Show'} ${subtaskCount} subtasks`}
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-3 w-3 transition-transform duration-200 ease-out"
              style={{ transform: subtasksOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
              aria-hidden="true"
            >
              <path d="M6 4l4 4-4 4V4z" />
            </svg>
            {subtasksDone}/{subtaskCount} subtasks
          </button>
        )}
      </div>

      {/* Collapsible subtask list — opt-in, default closed so cards stay short. */}
      {subtaskCount > 0 && subtasksOpen && (
        <ul
          className="mt-2 pt-2 border-t border-border/60 space-y-1 stagger-list"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {subtasks.map((s) => (
            <li
              key={s.id}
              className="stagger-item flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <TypeBadge type={s.type ?? 'Subtask'} />
              <span className="font-mono text-[10px] shrink-0">{s.key.split('-').pop()}</span>
              <span className="truncate flex-1 text-foreground/90">{s.title}</span>
              <StatusPill status={s.status} className="text-[9px] px-1.5 py-0" />
            </li>
          ))}
        </ul>
      )}
    </div>
    </div>
  );
}

// =============================================================================
// Create task dialog
// =============================================================================

interface CreateTaskInput {
  projectId: string;
  type: TaskType;
  title: string;
  description?: string;
  priority: Priority;
  assigneeUserId?: string;
  dueDate?: string;
  estimate?: number;
}

interface UserListResponse {
  items: User[];
  nextCursor: string | null;
}

// =============================================================================
// GalleryTemplate — workspace-wide template surfaced in the New Task drawer.
// Carries enough context (source project + tags + type) for the cards to
// render without an extra round-trip.
// =============================================================================
interface GalleryTemplate {
  id: string;
  name: string;
  description: string | null;
  titleTemplate: string;
  bodyTemplate: string | null;
  priority: Priority;
  estimate: number | null;
  taskType: TaskType | null;
  tags: string[];
  project: { id: string; key: string; name: string };
}

function CreateTaskDialog({
  project,
  defaultStatus,
  onClose,
}: {
  project: Project;
  defaultStatus: string | null;
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<TaskType>('Task');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('Medium');
  const [assigneeUserId, setAssigneeUserId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [estimate, setEstimate] = useState('');
  /// Two-pane drawer: gallery on the left, form on the right. The gallery
  /// stays mounted so toggling a filter doesn't refetch — react-query
  /// caches the underlying list. Hidden on mobile (xl: prefix) where the
  /// drawer's already narrow.
  const [galleryOpen, setGalleryOpen] = useState(true);
  const [galleryType, setGalleryType] = useState<'' | TaskType>('');
  const [galleryTag, setGalleryTag] = useState('');
  const [gallerySearch, setGallerySearch] = useState('');

  const usersQuery = useQuery({
    queryKey: ['users', 'list'],
    queryFn: () => api.get<UserListResponse>('/users?limit=100'),
  });

  const galleryQuery = useQuery({
    queryKey: ['task-templates', 'gallery', galleryType, galleryTag, gallerySearch],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (galleryType) qs.set('type', galleryType);
      if (galleryTag) qs.set('tag', galleryTag);
      if (gallerySearch) qs.set('q', gallerySearch);
      const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
      return api.get<GalleryTemplate[]>(`/task-templates/gallery${suffix}`);
    },
    // Keep stale data while filtering so the list doesn't visibly clear on
    // each keystroke — feels jumpy otherwise.
    placeholderData: (prev) => prev,
  });
  const tagsQuery = useQuery({
    queryKey: ['task-templates', 'tags'],
    queryFn: () => api.get<string[]>('/task-templates/tags'),
  });
  const templates = galleryQuery.data ?? [];
  const availableTags = tagsQuery.data ?? [];

  /// Pre-fill the form from a template. The form fields drive the eventual
  /// POST /tasks call exactly as if the user typed everything; we don't
  /// auto-instantiate so the user can still edit before committing.
  function applyTemplate(t: GalleryTemplate): void {
    setTitle(t.titleTemplate);
    setDescription(t.bodyTemplate ?? '');
    setPriority(t.priority);
    if (t.taskType) setType(t.taskType);
    if (t.estimate !== null) setEstimate(String(t.estimate));
    // Surface a toast so it's obvious which template populated the form —
    // otherwise the user can't tell whether they're editing from a template
    // or starting fresh.
    toast.success(`Loaded "${t.name}" from ${t.project.key}`);
  }

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: async (input: CreateTaskInput) => {
      const created = await api.post<Task & { status: string }>('/tasks', input);
      // If the user clicked "+ Add task" inside a column, move the task straight
      // to that column instead of leaving it in Todo.
      if (defaultStatus && defaultStatus !== created.status) {
        await api.patch(`/tasks/${created.id}/status`, { status: defaultStatus });
      }
      return created;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks', 'project', project.id] });
      toast.success('Task created');
      onClose();
    },
    onError: (err) => {
      const detail =
        err instanceof ApiError
          ? err.problem.title || err.problem.detail || err.message
          : 'Failed to create task';
      toast.error(detail);
    },
  });

  const valid = title.trim().length > 0 && title.length <= 300;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!valid) return;
    const input: CreateTaskInput = {
      projectId: project.id,
      type,
      title: title.trim(),
      priority,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(assigneeUserId ? { assigneeUserId } : {}),
      ...(dueDate ? { dueDate: new Date(dueDate).toISOString() } : {}),
      ...(estimate ? { estimate: Number(estimate) } : {}),
    };
    await mutation.mutateAsync(input);
  }

  return (
    <div
      className="animate-overlay-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          'animate-dialog-in w-full rounded-lg border border-border bg-card shadow-xl flex flex-col xl:flex-row max-h-[90vh] overflow-hidden',
          galleryOpen ? 'max-w-5xl' : 'max-w-xl',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {galleryOpen && (
          <TemplateGalleryPane
            templates={templates}
            tags={availableTags}
            loading={galleryQuery.isLoading}
            galleryType={galleryType}
            galleryTag={galleryTag}
            gallerySearch={gallerySearch}
            onTypeChange={setGalleryType}
            onTagChange={setGalleryTag}
            onSearchChange={setGallerySearch}
            onApply={applyTemplate}
            onClose={() => setGalleryOpen(false)}
          />
        )}
        <form onSubmit={submit} className="flex-1 flex flex-col min-w-0">
          <div className="px-6 py-5 border-b border-border flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">New task</h2>
            <div className="flex items-center gap-3">
              {!galleryOpen && (
                <button
                  type="button"
                  onClick={() => setGalleryOpen(true)}
                  className="tap inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  <FileText className="h-3 w-3" />
                  Templates
                </button>
              )}
              <span className="text-xs text-muted-foreground font-mono">
                {project.key} · {defaultStatus ?? 'Todo'}
              </span>
            </div>
          </div>
          <div className="px-6 py-5 space-y-4 flex-1 overflow-y-auto">
            <TaskField label="Type" htmlFor="task-type" hint="Subtasks need a parent — create one from a task drawer instead.">
              <div className="flex flex-wrap gap-1.5">
                {(['Epic', 'Story', 'Task', 'Bug'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={cn(
                      'tap inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                      type === t
                        ? 'border-brand/50 bg-accent text-foreground'
                        : 'border-border bg-background/40 text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    <TypeBadge type={t} />
                    {t}
                  </button>
                ))}
              </div>
            </TaskField>
            <TaskField label="Title" htmlFor="task-title">
              <input
                id="task-title"
                type="text"
                required
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs to happen?"
                maxLength={300}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </TaskField>
            <TaskField label="Description" htmlFor="task-description" hint="Optional. Markdown supported.">
              <textarea
                id="task-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                maxLength={20_000}
                placeholder="Context, acceptance criteria, screenshots…"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
              />
            </TaskField>
            <div className="grid grid-cols-2 gap-4">
              <TaskField label="Priority" htmlFor="task-priority">
                <select
                  id="task-priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as Priority)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                  <option value="Critical">Critical</option>
                </select>
              </TaskField>
              <TaskField label="Assignee" htmlFor="task-assignee">
                <select
                  id="task-assignee"
                  value={assigneeUserId}
                  onChange={(e) => setAssigneeUserId(e.target.value)}
                  disabled={usersQuery.isLoading}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Unassigned</option>
                  {(usersQuery.data?.items ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || u.email}
                    </option>
                  ))}
                </select>
              </TaskField>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <TaskField label="Due date" htmlFor="task-due" hint="Optional.">
                <input
                  id="task-due"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </TaskField>
              <TaskField label="Estimate" htmlFor="task-estimate" hint="Optional. Unit-agnostic.">
                <input
                  id="task-estimate"
                  type="number"
                  min={0}
                  step={1}
                  value={estimate}
                  onChange={(e) => setEstimate(e.target.value)}
                  placeholder="e.g. 3"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </TaskField>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="tap rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || mutation.isPending}
              className="tap rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-[opacity,transform] duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {mutation.isPending ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Cross-project template gallery shown to the left of the New Task form.
 * Filterable by issue type (Epic/Story/Task/Bug), tag, and free-text search.
 * Clicking a card pre-fills the form without committing — the user still has
 * to click "Create" so they can still tweak the title / assignee.
 */
function TemplateGalleryPane({
  templates,
  tags,
  loading,
  galleryType,
  galleryTag,
  gallerySearch,
  onTypeChange,
  onTagChange,
  onSearchChange,
  onApply,
  onClose,
}: {
  templates: GalleryTemplate[];
  tags: string[];
  loading: boolean;
  galleryType: '' | TaskType;
  galleryTag: string;
  gallerySearch: string;
  onTypeChange: (v: '' | TaskType) => void;
  onTagChange: (v: string) => void;
  onSearchChange: (v: string) => void;
  onApply: (t: GalleryTemplate) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <aside className="w-full xl:w-80 shrink-0 border-b xl:border-b-0 xl:border-r border-border bg-background/40 flex flex-col">
      <header className="px-4 py-3 border-b border-border flex items-baseline justify-between gap-2">
        <div>
          <p className="nockta-eyebrow text-muted-foreground">Templates</p>
          <p className="text-xs text-muted-foreground/80 mt-0.5">
            Across every project you can see
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Hide template gallery"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="px-4 py-3 space-y-2 border-b border-border">
        <input
          type="search"
          value={gallerySearch}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search templates…"
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
        />
        <div className="flex gap-2">
          <select
            value={galleryType}
            onChange={(e) => onTypeChange(e.target.value as '' | TaskType)}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
            aria-label="Filter templates by type"
          >
            <option value="">All types</option>
            <option value="Epic">Epic</option>
            <option value="Story">Story</option>
            <option value="Task">Task</option>
            <option value="Bug">Bug</option>
          </select>
          <select
            value={galleryTag}
            onChange={(e) => onTagChange(e.target.value)}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
            aria-label="Filter templates by tag"
          >
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        {(galleryType || galleryTag || gallerySearch) && (
          <button
            type="button"
            onClick={() => {
              onTypeChange('');
              onTagChange('');
              onSearchChange('');
            }}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" /> Clear filters
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 max-h-[40vh] xl:max-h-none">
        {loading && templates.length === 0 && (
          <p className="text-center text-xs text-muted-foreground py-8">Loading…</p>
        )}
        {!loading && templates.length === 0 && (
          <p className="text-center text-xs text-muted-foreground py-8">
            No templates match these filters.
          </p>
        )}
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onApply(t)}
            className="tap w-full text-left rounded-md border border-border/60 bg-card/60 px-3 py-2 hover:border-primary/40 hover:bg-accent/40 transition-colors"
          >
            <div className="flex items-center gap-2 mb-0.5">
              {t.taskType && <TypeBadge type={t.taskType} />}
              <span className="font-medium text-xs truncate flex-1">{t.name}</span>
              <span
                title={`${t.project.name} (${t.project.key})`}
                className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded shrink-0"
              >
                {t.project.key}
              </span>
            </div>
            {t.description && (
              <p className="text-[11px] text-muted-foreground line-clamp-2">{t.description}</p>
            )}
            {t.tags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {t.tags.slice(0, 4).map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-secondary/60 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
    </aside>
  );
}

function TaskField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground mb-1">
        {label}
      </label>
      {children}
      {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}
