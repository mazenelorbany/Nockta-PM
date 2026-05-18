import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useParams, useSearchParams } from 'react-router-dom';

import { ProjectTabs } from '../components/ProjectTabs';
import { TaskDetailDrawer } from '../components/TaskDetailDrawer';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

import { GanttGrid } from './project-timeline/GanttGrid';
import { MobileTimelineList } from './project-timeline/MobileTimelineList';
import { TimelineFilters } from './project-timeline/TimelineFilters';
import { UnscheduledLane } from './project-timeline/UnscheduledLane';
import {
  DAY_MS,
  ZOOM_PX_PER_DAY,
  type DragMode,
  type DragState,
  type Project,
  type Task,
  type ZoomMode,
} from './project-timeline/types';
import {
  computeArrows,
  computeAxisBounds,
  computeAxisCells,
  computeBarPositions,
} from './project-timeline/geometry';
import { apiErrorMessage } from './project-timeline/utils';

// =============================================================================
// /projects/:projectId/timeline — Gantt-style view. Tasks with startDate +
// dueDate render as horizontal bars on a date axis. Tasks missing either
// date show under a "Needs scheduling" lane at the top.
//
// Interactions:
//   - Click a bar to open the task drawer (drag handler swallows click if
//     a real drag happened).
//   - Drag the body of a bar to shift both dates by the same delta.
//   - Drag the right edge to extend dueDate; drag the left edge to pull
//     startDate. Min length is one day.
//   - Drag an unscheduled-lane row onto the grid to schedule it: drop
//     position becomes startDate, dueDate defaults to start + 2 days.
//
// All drag math is done in "days from axisStart" so day snapping is implicit.
// Dragging is preview-only until pointerup; PATCH fires once, on release.
// =============================================================================

export function ProjectTimelinePage(): JSX.Element {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get('task');
  const queryClient = useQueryClient();

  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const tasksQuery = useQuery({
    queryKey: queryKeys.projectTasks(projectId),
    queryFn: () => api.get<Task[]>(`/tasks/project/${projectId}`),
    enabled: Boolean(projectId),
  });

  // Filters
  const [search, setSearch] = useState('');
  const [hideDone, setHideDone] = useState(true);

  // Zoom level — Day / Week / Month. Persisted in localStorage so jumping
  // away from the page and back keeps the user's chosen scale.
  const [zoom, setZoom] = useState<ZoomMode>(() => {
    if (typeof window === 'undefined') return 'day';
    const raw = window.localStorage.getItem('nockta.timeline.zoom');
    return raw === 'week' || raw === 'month' ? raw : 'day';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('nockta.timeline.zoom', zoom);
  }, [zoom]);
  const PX_PER_DAY = ZOOM_PX_PER_DAY[zoom];

  // Dependency arrow overlay — default ON, persisted in localStorage.
  const [showDeps, setShowDeps] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const raw = window.localStorage.getItem('nockta.timeline.deps');
    return raw === null ? true : raw === 'true';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('nockta.timeline.deps', String(showDeps));
  }, [showDeps]);

  // Mobile fallback — the Gantt is inherently wide and pointer-based drag
  // doesn't translate to phones, so at <md we render a per-task list view
  // sorted by start date instead of the chart.
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const project = projectQuery.data;
  const tasks = useMemo(() => (tasksQuery.data ?? []).filter((t) => !t.parentTaskId), [tasksQuery.data]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      if (hideDone && t.status.toLowerCase() === 'done') return false;
      if (q && !`${t.key} ${t.title}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tasks, search, hideDone]);

  // Compute the date axis bounds: 4 weeks before earliest scheduled task,
  // 8 weeks after latest. Always include "today" for a vertical now marker.
  const { axisStart, axisEnd, dayCount } = useMemo(() => computeAxisBounds(visible), [visible]);

  // Partition tasks into "scheduled" (both dates) and "needs scheduling"
  const scheduled = visible.filter((t) => t.startDate && t.dueDate);
  const unscheduled = visible.filter((t) => !t.startDate || !t.dueDate);

  const patchTask = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/tasks/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not save')),
  });

  const [drag, setDrag] = useState<DragState | null>(null);
  const gridBodyRef = useRef<HTMLDivElement>(null);
  // Scroll container — we observe its scrollTop/clientHeight so we can skip
  // drawing arrows for tasks that are scrolled out of view (perf + clarity).
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const update = (): void => {
      setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  // Helpers — pure date math. Round to whole-day so dates always land at midnight.
  const daysFromAxis = useCallback((iso: string): number => {
    const d = new Date(iso);
    d.setHours(0, 0, 0, 0);
    return Math.round((d.getTime() - axisStart.getTime()) / DAY_MS);
  }, [axisStart]);
  const isoFromDays = useCallback((days: number): string => {
    const d = new Date(axisStart.getTime() + days * DAY_MS);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, [axisStart]);

  // Global pointer move/up listeners — attached only while a drag is live so
  // the rest of the page stays clean.
  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent): void {
      setDrag((d) => {
        if (!d) return d;
        const deltaPx = e.clientX - d.pointerStartX;
        const deltaDays = Math.round(deltaPx / PX_PER_DAY);
        const moved = d.moved || Math.abs(deltaPx) > 3;
        if (d.mode === 'schedule') {
          // For unscheduled rows the bounding rect of the grid body lets us
          // convert clientX to a day-from-axisStart absolute position.
          const rect = gridBodyRef.current?.getBoundingClientRect();
          const x = rect ? e.clientX - rect.left : 0;
          const day = Math.max(0, Math.round(x / PX_PER_DAY));
          return { ...d, dropDay: day, moved };
        }
        return { ...d, deltaDays, moved };
      });
    }
    function onUp(): void {
      setDrag((d) => {
        if (!d || !d.moved) return null;
        // Commit. Different write per mode; min-length clamp on resize.
        if (d.mode === 'move') {
          patchTask.mutate({
            id: d.taskId,
            body: {
              startDate: isoFromDays(d.originStartDay + d.deltaDays),
              dueDate: isoFromDays(d.originEndDay + d.deltaDays),
            },
          });
        } else if (d.mode === 'resize-right') {
          const newEnd = Math.max(d.originStartDay, d.originEndDay + d.deltaDays);
          patchTask.mutate({
            id: d.taskId,
            body: { dueDate: isoFromDays(newEnd) },
          });
        } else if (d.mode === 'resize-left') {
          const newStart = Math.min(d.originEndDay, d.originStartDay + d.deltaDays);
          patchTask.mutate({
            id: d.taskId,
            body: { startDate: isoFromDays(newStart) },
          });
        } else if (d.mode === 'schedule' && d.dropDay !== null) {
          // Default 3-day window when scheduling from the unscheduled lane.
          patchTask.mutate({
            id: d.taskId,
            body: {
              startDate: isoFromDays(d.dropDay),
              dueDate: isoFromDays(d.dropDay + 2),
            },
          });
        }
        return null;
      });
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, patchTask, isoFromDays, PX_PER_DAY]);

  function openTask(id: string): void {
    setSearchParams((sp) => {
      sp.set('task', id);
      return sp;
    });
  }
  function closeTask(): void {
    setSearchParams((sp) => {
      sp.delete('task');
      return sp;
    });
  }

  if (!project) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  const axisCells = computeAxisCells(axisStart, axisEnd, PX_PER_DAY, zoom);

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const nowLeft = ((now.getTime() - axisStart.getTime()) / DAY_MS) * PX_PER_DAY;
  const totalWidth = dayCount * PX_PER_DAY;

  const barPositions = computeBarPositions(scheduled, drag, PX_PER_DAY, daysFromAxis);
  const arrows = showDeps ? computeArrows(barPositions, viewport) : [];

  function onStartScheduleDrag(e: React.PointerEvent<HTMLLIElement>, taskId: string): void {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      taskId,
      mode: 'schedule',
      pointerStartX: e.clientX,
      originStartDay: 0,
      originEndDay: 0,
      deltaDays: 0,
      dropDay: null,
      moved: false,
    });
  }

  function onStartBarDrag(
    e: React.PointerEvent<HTMLDivElement>,
    taskId: string,
    mode: DragMode,
    originStartDay: number,
    originEndDay: number,
  ): void {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      taskId,
      mode,
      pointerStartX: e.clientX,
      originStartDay,
      originEndDay,
      deltaDays: 0,
      dropDay: null,
      moved: false,
    });
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-3 sm:py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">
            {project.key}
          </span>
          <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate">{project.name}</h1>
          <span className="text-muted-foreground/60 hidden sm:inline">·</span>
          <span className="text-sm text-muted-foreground hidden sm:inline">Timeline</span>
        </div>
      </header>

      <ProjectTabs projectId={projectId} />

      <TimelineFilters
        search={search}
        setSearch={setSearch}
        hideDone={hideDone}
        setHideDone={setHideDone}
        showDeps={showDeps}
        setShowDeps={setShowDeps}
        zoom={zoom}
        setZoom={setZoom}
        scheduledCount={scheduled.length}
        unscheduledCount={unscheduled.length}
      />

      {isMobile ? (
        <MobileTimelineList
          tasks={visible}
          onOpenTask={openTask}
        />
      ) : (
      <div ref={scrollContainerRef} className="flex-1 overflow-auto">
        <UnscheduledLane
          unscheduled={unscheduled}
          drag={drag}
          onStartScheduleDrag={onStartScheduleDrag}
          onClickRow={openTask}
          onSetDate={(taskId, body) => patchTask.mutate({ id: taskId, body })}
        />

        <GanttGrid
          ref={gridBodyRef}
          scheduled={scheduled}
          barPositions={barPositions}
          arrows={arrows}
          axisCells={axisCells}
          totalWidth={totalWidth}
          pxPerDay={PX_PER_DAY}
          nowLeft={nowLeft}
          showDeps={showDeps}
          drag={drag}
          onOpenTask={openTask}
          onStartBarDrag={onStartBarDrag}
        />
      </div>
      )}

      {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />}
    </div>
  );
}
