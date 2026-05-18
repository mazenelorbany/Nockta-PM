import type {
  useSensors} from '@dnd-kit/core';
import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay
} from '@dnd-kit/core';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@nockta/ui';

import { BoardColumn } from './BoardColumn';
import { DragOverlayCard } from './DragOverlayCard';
import type { Task } from './types';

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
  /** When false (Viewer / no-role), the per-column "+ Add task" button is
   *  hidden and dnd-kit drags are dropped on the floor — Viewers can still
   *  click cards to read them but can't mutate the board. */
  canEdit: boolean;
}

export function BoardCanvas(props: BoardCanvasProps): JSX.Element {
  const {
    columns, byStatus, subtasksByParent, selectedIds, toggleSelect,
    onAdd, onOpen, onDragEnd, sensors,
    isMobile, mobileColumnIdx, setMobileColumnIdx, onSwipeAction,
    canEdit,
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
                canEdit={canEdit}
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
              canEdit={canEdit}
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
