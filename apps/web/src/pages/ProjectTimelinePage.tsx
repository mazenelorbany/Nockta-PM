import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useParams, useSearchParams } from 'react-router-dom';
import { ProjectTabs } from '../components/ProjectTabs';
import { ApiError } from '@nockta/sdk';
import { cn } from '@nockta/ui';
import { TaskDetailDrawer } from '../components/TaskDetailDrawer';
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

interface TaskLinkLite {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  type: 'blocks' | 'related' | 'duplicate';
}

interface Task {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  startDate?: string | null;
  dueDate?: string | null;
  parentTaskId?: string | null;
  assignee?: { id: string; name: string; avatarUrl?: string | null };
  /** Outgoing links only; we filter to `blocks` server-side. */
  fromLinks?: TaskLinkLite[];
}

interface Project {
  id: string;
  key: string;
  name: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_PX_PER_DAY = 40;

type ZoomMode = 'day' | 'week' | 'month';

// Width-per-day for each zoom level. Kept uniform per-day inside a zoom so the
// bar/drag math (`days × PX_PER_DAY`) stays linear — any visual treatment of
// weekends in week view (faint background stripes etc) must be a paint-only
// effect, never a literal width change, or drag-to-set-dates breaks.
//
//   day   — 40 px/day (historical default; one week = 280 px).
//   week  — 60 px / 7 days ≈ 8.57 px/day. Spec: "each week = day-width × 1.5".
//   month — auto-tuned so a quarter (~90 days) fits within ~1080px on a 1440px
//           viewport less the 300px sidebar (1080 / 90 = 12 px/day).
const ZOOM_PX_PER_DAY: Record<ZoomMode, number> = {
  day: BASE_PX_PER_DAY,
  week: (BASE_PX_PER_DAY * 1.5) / 7,
  month: 12,
};

export function ProjectTimelinePage(): JSX.Element {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get('task');
  const queryClient = useQueryClient();

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
  const { axisStart, axisEnd, dayCount } = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const dates: number[] = [now.getTime()];
    for (const t of visible) {
      if (t.startDate) dates.push(new Date(t.startDate).getTime());
      if (t.dueDate) dates.push(new Date(t.dueDate).getTime());
    }
    const min = Math.min(...dates);
    const max = Math.max(...dates);
    const start = new Date(min - 14 * DAY_MS);
    start.setHours(0, 0, 0, 0);
    const end = new Date(max + 14 * DAY_MS);
    end.setHours(0, 0, 0, 0);
    const days = Math.max(28, Math.ceil((end.getTime() - start.getTime()) / DAY_MS));
    return { axisStart: start, axisEnd: end, dayCount: days };
  }, [visible]);

  // Partition tasks into "scheduled" (both dates) and "needs scheduling"
  const scheduled = visible.filter((t) => t.startDate && t.dueDate);
  const unscheduled = visible.filter((t) => !t.startDate || !t.dueDate);

  const patchTask = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/tasks/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'project', projectId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not save')),
  });

  // ---- Drag state -------------------------------------------------------
  // One live drag at a time. `mode` distinguishes move/resize-left/resize-right
  // on scheduled bars from "drop-to-schedule" on unscheduled rows. The grid
  // body's bounding rect is captured on pointerdown so we can compute day
  // offsets without re-measuring on every move event.
  type DragMode = 'move' | 'resize-left' | 'resize-right' | 'schedule';
  interface DragState {
    taskId: string;
    mode: DragMode;
    pointerStartX: number;
    /** Days from axisStart at drag start — for move/resize. */
    originStartDay: number;
    originEndDay: number;
    /** Live delta in days. */
    deltaDays: number;
    /** For 'schedule': the live drop position in days-from-axisStart. */
    dropDay: number | null;
    /** True if the pointer has moved past the click threshold; click handlers
     *  on the bar check this on pointerup so a no-drag click still opens the
     *  task drawer. */
    moved: boolean;
  }
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

  // Header strip cells. In day/week zoom we lay out one cell per week
  // (Mon-start, label = "Jan 5"). In month zoom we group by calendar month so
  // a quarterly view doesn't drown in tiny weekly tick marks.
  type AxisCell = { key: string; label: string; left: number; days: number };
  const axisCells: AxisCell[] = [];
  if (zoom === 'month') {
    // One cell per calendar month covered by [axisStart, axisEnd].
    let monthCursor = new Date(axisStart.getFullYear(), axisStart.getMonth(), 1);
    while (monthCursor < axisEnd) {
      const next = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
      const startMs = Math.max(monthCursor.getTime(), axisStart.getTime());
      const endMs = Math.min(next.getTime(), axisEnd.getTime());
      const left = ((startMs - axisStart.getTime()) / DAY_MS) * PX_PER_DAY;
      const days = Math.max(1, Math.round((endMs - startMs) / DAY_MS));
      axisCells.push({
        key: `${monthCursor.getFullYear()}-${monthCursor.getMonth()}`,
        label: monthCursor.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
        left,
        days,
      });
      monthCursor = next;
    }
  } else {
    let cursor = new Date(axisStart);
    while (cursor.getDay() !== 1) {
      cursor = new Date(cursor.getTime() - DAY_MS);
    }
    while (cursor < axisEnd) {
      const left = ((cursor.getTime() - axisStart.getTime()) / DAY_MS) * PX_PER_DAY;
      axisCells.push({
        key: String(cursor.getTime()),
        label: cursor.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        left,
        days: 7,
      });
      cursor = new Date(cursor.getTime() + 7 * DAY_MS);
    }
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const nowLeft = ((now.getTime() - axisStart.getTime()) / DAY_MS) * PX_PER_DAY;
  const totalWidth = dayCount * PX_PER_DAY;

  // Geometry per scheduled task — drag-aware live positions so the dependency
  // arrows track the bars during move/resize. Row Y math mirrors the JSX:
  // 48px axis header + 36px per row, bar height 24px (centered).
  const HEADER_H = 48;
  const ROW_H = 36;
  const barPositions = scheduled.map((t, idx) => {
    const originStartDay = daysFromAxis(t.startDate!);
    const originEndDay = daysFromAxis(t.dueDate!);
    const isDragging = drag?.taskId === t.id;
    let startDay = originStartDay;
    let endDay = originEndDay;
    if (isDragging && drag) {
      if (drag.mode === 'move') {
        startDay += drag.deltaDays;
        endDay += drag.deltaDays;
      } else if (drag.mode === 'resize-right') {
        endDay = Math.max(startDay, endDay + drag.deltaDays);
      } else if (drag.mode === 'resize-left') {
        startDay = Math.min(endDay, startDay + drag.deltaDays);
      }
    }
    const lengthDays = Math.max(1, endDay - startDay + 1);
    const left = startDay * PX_PER_DAY;
    const width = Math.max(40, lengthDays * PX_PER_DAY);
    const rowTop = HEADER_H + idx * ROW_H;
    return {
      task: t,
      originStartDay,
      originEndDay,
      left,
      width,
      rowTop,
      midY: rowTop + ROW_H / 2,
      rightX: left + width,
      leftX: left,
    };
  });
  const barById = new Map(barPositions.map((b) => [b.task.id, b]));

  // Resolve dependency arrows. We only look at outgoing `blocks` links from
  // each task — this is the coarse shape extended onto the list endpoint
  // (`fromLinks: [{ fromTaskId, toTaskId, type }]`). De-dup by (from,to) pair
  // in case the API ever returns duplicates from a buggy migration.
  type Arrow = {
    key: string;
    fromX: number; fromY: number;
    toX: number; toY: number;
  };
  const arrows: Arrow[] = [];
  if (showDeps) {
    const seen = new Set<string>();
    // Visible-row window relative to gridBody (in px). A row is "visible
    // vertically" if any part of its band overlaps the scroll viewport. We
    // give a generous 50px buffer above/below so arrows don't pop at edges.
    const viewTop = viewport.scrollTop - 50;
    const viewBottom = viewport.scrollTop + viewport.height + 50;
    for (const src of barPositions) {
      const links = src.task.fromLinks ?? [];
      for (const link of links) {
        if (link.type !== 'blocks') continue;
        const dst = barById.get(link.toTaskId);
        if (!dst) continue;
        const dedupe = `${src.task.id}->${dst.task.id}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        // Skip when either endpoint is scrolled out of view — keeps the
        // overlay clean and cheap to render on long projects.
        if (viewport.height > 0) {
          const srcVisible = src.rowTop + ROW_H >= viewTop && src.rowTop <= viewBottom;
          const dstVisible = dst.rowTop + ROW_H >= viewTop && dst.rowTop <= viewBottom;
          if (!srcVisible || !dstVisible) continue;
        }
        arrows.push({
          key: `${link.id ?? dedupe}`,
          fromX: src.rightX,
          fromY: src.midY,
          toX: dst.leftX,
          toY: dst.midY,
        });
      }
    }
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

      <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <label className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks…"
            className="h-7 w-full sm:w-64 rounded-md bg-secondary/60 pl-7 pr-2 text-xs"
          />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={hideDone}
            onChange={(e) => setHideDone(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Hide done
        </label>

        {/* Show-dependencies toggle. Default ON; persisted in localStorage as
            `nockta.timeline.deps`. */}
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={showDeps}
            onChange={(e) => setShowDeps(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Show dependencies
        </label>

        {/* Day / Week / Month zoom switcher. Persisted as `nockta.timeline.zoom`. */}
        <div className="inline-flex items-center rounded-md border border-border bg-secondary/40 p-0.5 text-xs">
          {(['day', 'week', 'month'] as const).map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => setZoom(z)}
              className={cn(
                'px-2 py-0.5 rounded text-[11px] capitalize transition-colors',
                zoom === z
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-pressed={zoom === z}
            >
              {z}
            </button>
          ))}
        </div>

        <span className="ml-auto nockta-eyebrow text-muted-foreground">
          {scheduled.length} scheduled · {unscheduled.length} unscheduled
        </span>
      </div>

      {isMobile ? (
        <MobileTimelineList
          tasks={visible}
          onOpenTask={openTask}
        />
      ) : (
      <div ref={scrollContainerRef} className="flex-1 overflow-auto">
        {/* Unscheduled lane — tasks missing one or both dates */}
        {unscheduled.length > 0 && (
          <section className="border-b border-border bg-card/20 px-4 sm:px-6 md:px-8 py-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              Needs scheduling ({unscheduled.length})
            </p>
            <ul className="space-y-1">
              {unscheduled.map((t) => (
                <li
                  key={t.id}
                  className={cn(
                    'flex items-center gap-2 text-xs hover:bg-muted/40 rounded px-2 py-1 cursor-grab',
                    drag?.taskId === t.id && 'opacity-50 cursor-grabbing',
                  )}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDrag({
                      taskId: t.id,
                      mode: 'schedule',
                      pointerStartX: e.clientX,
                      originStartDay: 0,
                      originEndDay: 0,
                      deltaDays: 0,
                      dropDay: null,
                      moved: false,
                    });
                  }}
                  onPointerUp={() => {
                    // If the user clicked without dragging, open the drawer.
                    if (drag && drag.taskId === t.id && !drag.moved) {
                      openTask(t.id);
                    }
                  }}
                  style={{ touchAction: 'none' }}
                  title="Drag onto the grid below to schedule this task"
                >
                  <span className="font-mono text-[10px] text-muted-foreground w-16">{t.key}</span>
                  {t.type && <TypeBadge type={t.type} />}
                  <PriorityDot priority={t.priority} />
                  <BlockedBadge blocked={t.isBlocked} />
                  <span className="flex-1 truncate">{t.title}</span>
                  <StatusPill status={t.status} />
                  {!t.startDate && (
                    <DateChip
                      task={t}
                      field="startDate"
                      onSet={(iso) => patchTask.mutate({ id: t.id, body: { startDate: iso } })}
                    />
                  )}
                  {!t.dueDate && (
                    <DateChip
                      task={t}
                      field="dueDate"
                      onSet={(iso) => patchTask.mutate({ id: t.id, body: { dueDate: iso } })}
                    />
                  )}
                  {t.assignee && <AvatarCircle user={t.assignee} size={16} />}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Gantt grid */}
        <section className="relative">
          {/* Sticky left-side task name column */}
          <div className="flex" style={{ minWidth: `${300 + totalWidth}px` }}>
            <aside className="w-[300px] shrink-0 sticky left-0 z-10 bg-background border-r border-border">
              <div className="h-12 border-b border-border flex items-center px-3 text-xs text-muted-foreground">
                Task
              </div>
              {scheduled.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => openTask(t.id)}
                  className="w-full h-9 px-3 flex items-center gap-2 text-xs text-left border-b border-border/40 hover:bg-muted/40 transition-colors"
                >
                  <span className="font-mono text-[10px] text-muted-foreground shrink-0">{t.key}</span>
                  {t.type && <TypeBadge type={t.type} />}
                  <span className="truncate flex-1">{t.title}</span>
                  {t.assignee && <AvatarCircle user={t.assignee} size={16} />}
                </button>
              ))}
              {scheduled.length === 0 && (
                <p className="px-3 py-6 text-xs text-muted-foreground">
                  No tasks scheduled yet. Set start and due dates on a task to see it on the timeline.
                </p>
              )}
            </aside>

            {/* Right side: date axis + bars. Ref captured so the unscheduled→
                schedule drag handler can convert pointer X to a grid day. */}
            <div ref={gridBodyRef} className="relative" style={{ width: `${totalWidth}px` }}>
              {/* Date axis */}
              <div className="sticky top-0 z-10 h-12 border-b border-border bg-background relative">
                {axisCells.map((w) => (
                  <div
                    key={w.key}
                    className="absolute top-0 h-full flex flex-col items-start justify-center text-[10px] text-muted-foreground"
                    style={{ left: w.left, width: w.days * PX_PER_DAY }}
                  >
                    <span className="px-2 font-mono">{w.label}</span>
                    <div className="absolute left-0 top-0 h-full border-l border-border/40" />
                  </div>
                ))}
              </div>

              {/* Today vertical marker */}
              {nowLeft >= 0 && nowLeft <= totalWidth && (
                <div
                  className="absolute top-0 bottom-0 w-px bg-primary/60 z-[5] pointer-events-none"
                  style={{ left: nowLeft }}
                >
                  <span className="absolute top-0 -translate-x-1/2 bg-primary text-primary-foreground rounded px-1 py-0.5 text-[9px] font-medium">
                    today
                  </span>
                </div>
              )}

              {/* Task rows. Each bar is a div (not a button) so we can attach
                  per-edge pointerdown handlers without the click semantics of a
                  button stealing focus. A no-drag click still opens the drawer
                  via the parent onPointerUp guard below. Geometry is computed
                  once in `barPositions` above so dependency arrows reuse the
                  same drag-aware positions. */}
              {barPositions.map(({ task: t, originStartDay, originEndDay, left, width }) => {
                const isDragging = drag?.taskId === t.id;
                return (
                  <div key={t.id} className="relative h-9 border-b border-border/40">
                    <div
                      role="button"
                      tabIndex={0}
                      onPointerDown={(e) => {
                        // Edge-zone detection — first 6px = left resize,
                        // last 6px = right resize, middle = move.
                        const rect = e.currentTarget.getBoundingClientRect();
                        const x = e.clientX - rect.left;
                        let mode: DragMode = 'move';
                        if (x <= 6) mode = 'resize-left';
                        else if (x >= rect.width - 6) mode = 'resize-right';
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDrag({
                          taskId: t.id,
                          mode,
                          pointerStartX: e.clientX,
                          originStartDay,
                          originEndDay,
                          deltaDays: 0,
                          dropDay: null,
                          moved: false,
                        });
                      }}
                      onPointerUp={() => {
                        // If this pointerdown→up cycle didn't move the bar, treat
                        // it as a click and open the task drawer.
                        if (drag && drag.taskId === t.id && !drag.moved) {
                          openTask(t.id);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openTask(t.id);
                        }
                      }}
                      className={cn(
                        'group absolute top-1/2 -translate-y-1/2 h-6 rounded-md text-[10px] text-white truncate text-left transition-[opacity,box-shadow] select-none',
                        priorityColor(t.priority),
                        t.isBlocked && 'ring-2 ring-status-blocked/60',
                        t.status.toLowerCase() === 'done' && 'opacity-50',
                        isDragging
                          ? 'opacity-90 shadow-lg cursor-grabbing'
                          : 'hover:opacity-90 cursor-grab',
                      )}
                      style={{ left, width, touchAction: 'none' }}
                      title={`${t.key} · ${t.title} · ${new Date(t.startDate!).toLocaleDateString()} → ${new Date(t.dueDate!).toLocaleDateString()}`}
                    >
                      {/* Left resize handle (invisible) */}
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/30"
                      />
                      <span className="block px-2 truncate pointer-events-none">{t.title}</span>
                      {/* Right resize handle (invisible) */}
                      <span
                        aria-hidden="true"
                        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/30"
                      />
                    </div>
                  </div>
                );
              })}

              {/* Dependency arrow overlay. SVG sits above the bars but below
                  tooltips, with pointer-events disabled so it never intercepts
                  bar drag/click. Each arrow is a cubic Bezier from a blocker's
                  right edge to the blocked task's left edge — control points
                  are offset by 20% of the horizontal distance from each end,
                  vertically aligned with the row mid, giving a smooth S-curve
                  for backward links and a gentle arc for forward links. */}
              {showDeps && arrows.length > 0 && (
                <svg
                  className="absolute inset-0 pointer-events-none z-[7]"
                  width={totalWidth}
                  height={HEADER_H + scheduled.length * ROW_H}
                  aria-hidden="true"
                >
                  <defs>
                    <marker
                      id="nockta-dep-arrow"
                      viewBox="0 0 8 8"
                      refX="7"
                      refY="4"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 8 4 L 0 8 z" className="fill-muted-foreground/70" />
                    </marker>
                  </defs>
                  {arrows.map((a) => {
                    const dx = Math.max(20, Math.abs(a.toX - a.fromX));
                    const offset = dx * 0.2;
                    const c1x = a.fromX + offset;
                    const c1y = a.fromY;
                    const c2x = a.toX - offset;
                    const c2y = a.toY;
                    const d = `M ${a.fromX} ${a.fromY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${a.toX} ${a.toY}`;
                    return (
                      <path
                        key={a.key}
                        d={d}
                        className="stroke-muted-foreground/70 fill-none"
                        strokeWidth={1.25}
                        markerEnd="url(#nockta-dep-arrow)"
                      />
                    );
                  })}
                </svg>
              )}

              {/* Drop preview for unscheduled→grid drags. Renders as a ghost
                  bar at the live drop position so the user can target a day. */}
              {drag && drag.mode === 'schedule' && drag.dropDay !== null && (
                <div
                  className="absolute top-0 bottom-0 pointer-events-none z-[6]"
                  style={{
                    left: drag.dropDay * PX_PER_DAY,
                    width: 3 * PX_PER_DAY,
                  }}
                >
                  <div className="h-6 mt-3 rounded-md border-2 border-dashed border-primary/70 bg-primary/15" />
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
      )}

      {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />}
    </div>
  );
}

// =============================================================================
// MobileTimelineList — drop-in for <md viewports. Gantt math doesn't survive
// a 375px wide screen, so we surface the same task set as a vertical list
// sorted by start date. Tap a row to open the task drawer; date editing
// still happens in the drawer where the calendar pickers fit.
// =============================================================================
function MobileTimelineList({
  tasks,
  onOpenTask,
}: {
  tasks: Task[];
  onOpenTask: (id: string) => void;
}): JSX.Element {
  const scheduled = tasks.filter((t) => t.startDate && t.dueDate);
  const unscheduled = tasks.filter((t) => !t.startDate || !t.dueDate);
  // Sort scheduled ascending by startDate so the earliest comes first.
  const sortedScheduled = [...scheduled].sort((a, b) => {
    const aT = a.startDate ? new Date(a.startDate).getTime() : 0;
    const bT = b.startDate ? new Date(b.startDate).getTime() : 0;
    return aT - bT;
  });

  function fmt(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  if (sortedScheduled.length === 0 && unscheduled.length === 0) {
    return (
      <div className="flex-1 overflow-auto p-4">
        <p className="text-sm text-muted-foreground text-center py-12">
          No tasks match your filters.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-3 space-y-4">
      {sortedScheduled.length > 0 && (
        <section>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 px-1">
            Scheduled ({sortedScheduled.length})
          </p>
          <ul className="space-y-2">
            {sortedScheduled.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onOpenTask(t.id)}
                  className="tap w-full text-left rounded-lg border border-border bg-card p-3 hover:border-ring transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1.5 min-w-0">
                    {t.type && <TypeBadge type={t.type} />}
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                      {t.key}
                    </span>
                    <PriorityDot priority={t.priority} />
                    <BlockedBadge blocked={t.isBlocked} />
                  </div>
                  <div className="text-sm font-medium leading-snug mb-2 line-clamp-2">
                    {t.title}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-[11px]">
                    <StatusPill status={t.status} />
                    <span className="inline-flex items-center gap-1 rounded bg-secondary/60 px-1.5 py-0.5 text-muted-foreground tabular-nums">
                      {fmt(t.startDate)} → {fmt(t.dueDate)}
                    </span>
                    {t.assignee && (
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground ml-auto">
                        <AvatarCircle user={t.assignee} size={16} />
                        <span className="truncate max-w-[120px]">{t.assignee.name}</span>
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unscheduled.length > 0 && (
        <section>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 px-1">
            Needs scheduling ({unscheduled.length})
          </p>
          <ul className="space-y-2">
            {unscheduled.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onOpenTask(t.id)}
                  className="tap w-full text-left rounded-lg border border-dashed border-border bg-card/40 p-3 hover:border-ring transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1.5 min-w-0">
                    {t.type && <TypeBadge type={t.type} />}
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                      {t.key}
                    </span>
                    <PriorityDot priority={t.priority} />
                    <BlockedBadge blocked={t.isBlocked} />
                  </div>
                  <div className="text-sm font-medium leading-snug mb-2 line-clamp-2">
                    {t.title}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-[11px]">
                    <StatusPill status={t.status} />
                    <span className="text-muted-foreground/70">
                      {t.startDate ? `Start ${fmt(t.startDate)}` : 'No start'}
                      {' · '}
                      {t.dueDate ? `Due ${fmt(t.dueDate)}` : 'No due'}
                    </span>
                    {t.assignee && (
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground ml-auto">
                        <AvatarCircle user={t.assignee} size={16} />
                        <span className="truncate max-w-[120px]">{t.assignee.name}</span>
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function priorityColor(p: Priority): string {
  switch (p) {
    case 'Critical': return 'bg-priority-critical';
    case 'High': return 'bg-priority-high';
    case 'Medium': return 'bg-primary';
    case 'Low': return 'bg-muted-foreground/60';
  }
}

function DateChip({
  task: _task,
  field,
  onSet,
}: {
  task: Task;
  field: 'startDate' | 'dueDate';
  onSet: (iso: string | null) => void;
}): JSX.Element {
  return (
    <label className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer">
      + {field === 'startDate' ? 'start' : 'due'}
      <input
        type="date"
        className="sr-only"
        onChange={(e) => {
          if (e.target.value) onSet(new Date(e.target.value).toISOString());
        }}
      />
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
