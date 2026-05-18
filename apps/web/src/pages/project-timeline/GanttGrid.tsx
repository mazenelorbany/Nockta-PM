import { forwardRef } from 'react';
import { cn } from '@nockta/ui';

import { AvatarCircle, TypeBadge } from '../../components/task-bits';

import { priorityColor } from './utils';
import type {
  Arrow,
  AxisCell,
  BarPosition,
  DragMode,
  DragState,
  Task,
} from './types';
import { HEADER_H, ROW_H } from './types';

// =============================================================================
// GanttGrid — the right-side date axis + bar rendering + dependency arrows +
// drop-preview overlay. The scrollable wrapper (and scroll-sync logic) lives
// in the parent because the unscheduled lane shares the same scroll.
//
// All drag bookkeeping lives in the parent (`drag` state + listeners). This
// component just calls `onStartBarDrag` on pointerdown with the chosen mode
// and the per-bar origin day window.
// =============================================================================
export const GanttGrid = forwardRef<
  HTMLDivElement,
  {
    scheduled: Task[];
    barPositions: BarPosition[];
    arrows: Arrow[];
    axisCells: AxisCell[];
    totalWidth: number;
    pxPerDay: number;
    nowLeft: number;
    showDeps: boolean;
    drag: DragState | null;
    onOpenTask: (id: string) => void;
    onStartBarDrag: (
      e: React.PointerEvent<HTMLDivElement>,
      taskId: string,
      mode: DragMode,
      originStartDay: number,
      originEndDay: number,
    ) => void;
  }
>(function GanttGrid(
  {
    scheduled,
    barPositions,
    arrows,
    axisCells,
    totalWidth,
    pxPerDay,
    nowLeft,
    showDeps,
    drag,
    onOpenTask,
    onStartBarDrag,
  },
  gridBodyRef,
) {
  return (
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
              onClick={() => onOpenTask(t.id)}
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
                style={{ left: w.left, width: w.days * pxPerDay }}
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
                    onStartBarDrag(e, t.id, mode, originStartDay, originEndDay);
                  }}
                  onPointerUp={() => {
                    // If this pointerdown→up cycle didn't move the bar, treat
                    // it as a click and open the task drawer.
                    if (drag && drag.taskId === t.id && !drag.moved) {
                      onOpenTask(t.id);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenTask(t.id);
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
                left: drag.dropDay * pxPerDay,
                width: 3 * pxPerDay,
              }}
            >
              <div className="h-6 mt-3 rounded-md border-2 border-dashed border-primary/70 bg-primary/15" />
            </div>
          )}
        </div>
      </div>
    </section>
  );
});
