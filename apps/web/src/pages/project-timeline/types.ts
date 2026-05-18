// Shared types + constants for ProjectTimelinePage and its sub-components.

import type { Priority, TaskType } from '../../components/task-bits';

export interface TaskLinkLite {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  type: 'blocks' | 'related' | 'duplicate';
}

export interface Task {
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

export interface Project {
  id: string;
  key: string;
  name: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const BASE_PX_PER_DAY = 40;

export type ZoomMode = 'day' | 'week' | 'month';

// Width-per-day for each zoom level. Kept uniform per-day inside a zoom so the
// bar/drag math (`days × PX_PER_DAY`) stays linear — any visual treatment of
// weekends in week view (faint background stripes etc) must be a paint-only
// effect, never a literal width change, or drag-to-set-dates breaks.
//
//   day   — 40 px/day (historical default; one week = 280 px).
//   week  — 60 px / 7 days ≈ 8.57 px/day. Spec: "each week = day-width × 1.5".
//   month — auto-tuned so a quarter (~90 days) fits within ~1080px on a 1440px
//           viewport less the 300px sidebar (1080 / 90 = 12 px/day).
export const ZOOM_PX_PER_DAY: Record<ZoomMode, number> = {
  day: BASE_PX_PER_DAY,
  week: (BASE_PX_PER_DAY * 1.5) / 7,
  month: 12,
};

// Row Y math mirrors the JSX: 48px axis header + 36px per row, bar height
// 24px (centered).
export const HEADER_H = 48;
export const ROW_H = 36;

// ---- Drag state -------------------------------------------------------
// One live drag at a time. `mode` distinguishes move/resize-left/resize-right
// on scheduled bars from "drop-to-schedule" on unscheduled rows. The grid
// body's bounding rect is captured on pointerdown so we can compute day
// offsets without re-measuring on every move event.
export type DragMode = 'move' | 'resize-left' | 'resize-right' | 'schedule';

export interface DragState {
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

export interface BarPosition {
  task: Task;
  originStartDay: number;
  originEndDay: number;
  left: number;
  width: number;
  rowTop: number;
  midY: number;
  rightX: number;
  leftX: number;
}

export type AxisCell = { key: string; label: string; left: number; days: number };

export type Arrow = {
  key: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
};
