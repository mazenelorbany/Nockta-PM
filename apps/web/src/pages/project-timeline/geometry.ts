import {
  DAY_MS,
  HEADER_H,
  ROW_H,
  type Arrow,
  type AxisCell,
  type BarPosition,
  type DragState,
  type Task,
  type ZoomMode,
} from './types';

// Compute the date axis bounds: 2 weeks before earliest scheduled task,
// 2 weeks after latest. Always include "today" for a vertical now marker.
export function computeAxisBounds(visible: Task[]): {
  axisStart: Date;
  axisEnd: Date;
  dayCount: number;
} {
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
}

// Header strip cells. In day/week zoom we lay out one cell per week
// (Mon-start, label = "Jan 5"). In month zoom we group by calendar month so
// a quarterly view doesn't drown in tiny weekly tick marks.
export function computeAxisCells(
  axisStart: Date,
  axisEnd: Date,
  pxPerDay: number,
  zoom: ZoomMode,
): AxisCell[] {
  const cells: AxisCell[] = [];
  if (zoom === 'month') {
    // One cell per calendar month covered by [axisStart, axisEnd].
    let monthCursor = new Date(axisStart.getFullYear(), axisStart.getMonth(), 1);
    while (monthCursor < axisEnd) {
      const next = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
      const startMs = Math.max(monthCursor.getTime(), axisStart.getTime());
      const endMs = Math.min(next.getTime(), axisEnd.getTime());
      const left = ((startMs - axisStart.getTime()) / DAY_MS) * pxPerDay;
      const days = Math.max(1, Math.round((endMs - startMs) / DAY_MS));
      cells.push({
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
      const left = ((cursor.getTime() - axisStart.getTime()) / DAY_MS) * pxPerDay;
      cells.push({
        key: String(cursor.getTime()),
        label: cursor.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        left,
        days: 7,
      });
      cursor = new Date(cursor.getTime() + 7 * DAY_MS);
    }
  }
  return cells;
}

// Geometry per scheduled task — drag-aware live positions so the dependency
// arrows track the bars during move/resize.
export function computeBarPositions(
  scheduled: Task[],
  drag: DragState | null,
  pxPerDay: number,
  daysFromAxis: (iso: string) => number,
): BarPosition[] {
  return scheduled.map((t, idx) => {
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
    const left = startDay * pxPerDay;
    const width = Math.max(40, lengthDays * pxPerDay);
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
}

// Resolve dependency arrows. We only look at outgoing `blocks` links from
// each task — this is the coarse shape extended onto the list endpoint
// (`fromLinks: [{ fromTaskId, toTaskId, type }]`). De-dup by (from,to) pair
// in case the API ever returns duplicates from a buggy migration.
export function computeArrows(
  barPositions: BarPosition[],
  viewport: { scrollTop: number; height: number },
): Arrow[] {
  const arrows: Arrow[] = [];
  const barById = new Map(barPositions.map((b) => [b.task.id, b]));
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
  return arrows;
}
