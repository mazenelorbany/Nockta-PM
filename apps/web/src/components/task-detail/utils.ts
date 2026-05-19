import { useState } from 'react';
import { ApiError } from '@nockta/sdk';

import { WEEKDAY_LABELS } from './constants';
import type { Recurrence } from './types';

export function usePopover(): {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  close: () => void;
} {
  const [open, setOpen] = useState(false);
  return {
    open,
    setOpen,
    toggle: () => setOpen((o) => !o),
    close: () => setOpen(false),
  };
}

export function formatDueDisplay(iso: string | null): string {
  if (!iso) return 'No date';
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(d) - startOfDay(now)) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  if (diffDays > 1 && diffDays <= 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function isOverdue(iso: string | null): boolean {
  if (!iso) return false;
  const due = new Date(iso).getTime();
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return due < startOfToday;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function humanizeRecurrence(r: Recurrence): string {
  if (r.frequency === 'daily') {
    return r.interval === 1 ? 'daily' : `every ${r.interval} days`;
  }
  if (r.frequency === 'weekly') {
    if (r.weekdays.length > 0) {
      const days = r.weekdays.map((d) => WEEKDAY_LABELS[d]).join(' ');
      return r.interval === 1 ? `weekly on ${days}` : `every ${r.interval} weeks on ${days}`;
    }
    return r.interval === 1 ? 'weekly' : `every ${r.interval} weeks`;
  }
  if (r.frequency === 'monthly') {
    const day = r.dayOfMonth ? `day ${r.dayOfMonth}` : 'same day';
    return r.interval === 1 ? `monthly (${day})` : `every ${r.interval} months (${day})`;
  }
  return r.frequency;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0 && s > 0 && seconds < 3600) return `${m}m ${s}s`;
  return `${m}m`;
}

// Human-readable verbs for known event types. Falls back to the
// camelCase/snake_case splitter below for anything not enumerated. Keep
// the labels short and verb-shaped — the timeline renders
// `<Actor> <label> · <relative time>`, so the label should fit there
// without sounding clunky.
const EVENT_LABELS: Record<string, string> = {
  TaskCreated: 'created the task',
  TaskUpdated: 'updated the task',
  TaskStatusChanged: 'changed the status',
  TaskBlocked: 'flagged the task as blocked',
  TaskUnblocked: 'cleared the blocked flag',
  TaskDeleted: 'deleted the task',
  CommentAdded: 'commented',
  CommentEdited: 'edited a comment',
  CommentDeleted: 'deleted a comment',
  ProjectCreated: 'created the project',
  ProjectVisibilityChanged: 'changed project visibility',
  ProjectArchived: 'archived the project',
  ProjectMemberAdded: 'granted project access',
  ProjectMemberRemoved: 'revoked project access',
  ProjectGuestInvited: 'invited a guest to the project',
  SprintCreated: 'created a sprint',
  SprintStarted: 'started the sprint',
  SprintCompleted: 'completed the sprint',
};

export function prettyEventType(t: string): string {
  const known = EVENT_LABELS[t];
  if (known) return known;
  // Fallback: split camelCase boundaries, replace dot/underscore with
  // spaces, lower-case. Matches the legacy behaviour for unknown event
  // names like `feature.shipped` (→ "feature shipped") and `TaskMoved`
  // (→ "task moved").
  return t
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._]/g, ' ')
    .toLowerCase()
    .trim();
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.problem.title || err.problem.detail || err.message || fallback;
  }
  return fallback;
}

export function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString();
}
