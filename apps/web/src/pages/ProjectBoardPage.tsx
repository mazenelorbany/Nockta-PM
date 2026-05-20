import { PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import { Play, Sun } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { QueryErrorState, Spinner } from '@nockta/ui';

import {
  BoardToolbar,
  EMPTY_FILTERS,
  type BoardView,
  type TaskFilters,
} from '../components/board-toolbar';
import { ProjectListView } from '../components/ProjectListView';
import { PresenceAvatars } from '../components/PresenceAvatars';
import { ProjectTabs } from '../components/ProjectTabs';
import { StandupRunner } from '../components/StandupRunner';
import { TaskDetailDrawer } from '../components/TaskDetailDrawer';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useResolvedProject } from '../lib/project-route';
import { queryKeys } from '../lib/query-keys';

import { ActiveSprintBanner } from './project-board/ActiveSprintBanner';
import { BoardCanvas } from './project-board/BoardCanvas';
import { BulkActionsContainer } from './project-board/BulkActionsBar';
import { useBoardData } from './project-board/hooks/useBoardData';
import { useDragReorder } from './project-board/hooks/useDragReorder';
import { CreateTaskDialog } from './project-board/TaskCreateModal';
import { TemplatesQuickCreate } from './project-board/TemplatesQuickCreate';

export function ProjectBoardPage(): JSX.Element {
  // Routes accept either the project KEY (`/projects/ACME/board`) or the
  // legacy UUID. `useResolvedProject` reads the URL param and looks it up
  // against the cached projects list, returning the canonical id we hand to
  // every downstream API call.
  const { projectId } = useResolvedProject();
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
  }, [view, setSearchParams]);

  // Apply a saved view from the sidebar via ?savedView=ID. Fetches /saved-views,
  // looks up the matching id, applies its filters + view, then strips the param
  // so subsequent toolbar changes don't get clobbered on URL update.
  const savedViewParam = searchParams.get('savedView');

  const {
    projectQuery,
    tasksQuery,
    sprintsQuery,
    savedViewsQuery,
    tasks,
    project,
    activeSprint,
    columns,
    visibleTasks,
    byStatus,
    subtasksByParent,
  } = useBoardData({ projectId, filters, savedViewParam });
  // sprintsQuery and tasksQuery are retained for invalidation paths below; the
  // explicit references keep them in scope after destructuring without
  // shadowing them in the JSX.
  void sprintsQuery;
  void tasksQuery;

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
  }, [savedViewParam, savedViewsQuery.data, setFilters, setView, setSearchParams]);

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

  // Realtime: join the project room and refetch on relevant events.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      socket.emit('project:join', { projectId });
      socket.on('task.created', invalidate);
      socket.on('task.updated', invalidate);
      socket.on('task.status_changed', invalidate);
      socket.on('task.blocked', invalidate);
      socket.on('task.unblocked', invalidate);
      socket.on('task.deleted', invalidate);
      cleanup = () => {
        socket.emit('project:leave', { projectId });
        socket.off('task.created', invalidate);
        socket.off('task.updated', invalidate);
        socket.off('task.status_changed', invalidate);
        socket.off('task.blocked', invalidate);
        socket.off('task.unblocked', invalidate);
        socket.off('task.deleted', invalidate);
      };
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [projectId, queryClient]);

  // Write affordances are gated on effective project role. Manager and
  // Contributor can edit; Viewer is read-only; Client is bug-only (handled
  // via the report-bug flow, not this board's "New task" button). Falling
  // back to `true` keeps existing behaviour while the project payload loads.
  const canEdit =
    project?.effectiveRole == null ||
    project.effectiveRole === 'Manager' ||
    project.effectiveRole === 'Contributor';

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
          void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
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
          void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
        } catch (err) {
          const detail = err instanceof ApiError ? err.problem.title || err.message : 'Could not snooze';
          toast.error(detail);
        }
      }
    },
    [tasks, project?.workflowPreset, projectId, queryClient],
  );

  const onDragEnd = useDragReorder({ tasks, projectId, queryClient });

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
                <span className="hidden sm:inline">{'Start standup'}</span>
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={() => openCreate(null)}
                className="tap rounded-md bg-primary px-3 sm:px-4 h-8 text-xs sm:text-sm font-medium text-primary-foreground hover:opacity-90 transition-[opacity,transform] duration-150"
              >
                <span className="sm:hidden">+</span>
                <span className="hidden sm:inline">{'New task'}</span>
              </button>
            )}
          </>
        }
      />

      {activeSprint && (
        <ActiveSprintBanner
          sprint={activeSprint}
          filters={filters}
          onFiltersChange={setFilters}
        />
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
      <div className="flex-1 flex min-h-0 overflow-hidden">
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
            onDragEnd={canEdit ? onDragEnd : () => {}}
            sensors={sensors}
            canEdit={canEdit}
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
      <BulkActionsContainer
        selectedIds={selectedIds}
        statuses={columns}
        projectId={projectId ?? ''}
        sprintsEnabled={Boolean(project?.sprintsEnabled)}
        onClear={clearSelection}
      />
    </div>
  );
}

