import { ApiError } from '@nockta/sdk';
import type { Action, Label, Trigger } from './types';

// ============================================================================
// Humanizers — turn config into prose
// ============================================================================

export function humanizeTrigger(
  trigger: Trigger,
  config: Record<string, unknown>,
  labels: Label[],
  userMap: Map<string, string>,
): string {
  switch (trigger) {
    case 'task_created': return 'a task is created';
    case 'task_status_changed': {
      const from = config.fromStatus as string | undefined;
      const to = config.toStatus as string | undefined;
      if (from && to) return `status: ${from} → ${to}`;
      if (to) return `status → ${to}`;
      if (from) return `status leaves ${from}`;
      return 'status changes';
    }
    case 'task_assigned': {
      const u = config.assigneeUserId as string | undefined;
      return u ? `assigned to ${userMap.get(u) ?? '…'}` : 'task assigned';
    }
    case 'task_unassigned': return 'assignee removed';
    case 'task_blocked': return 'task marked blocked';
    case 'task_labeled': {
      const id = config.labelId as string | undefined;
      const l = labels.find((x) => x.id === id);
      return l ? `label "${l.name}" added` : 'a label is added';
    }
    case 'comment_added': return 'a comment is added';
    case 'task_due_soon': return 'due date approaching';
    default: return trigger;
  }
}

export function humanizeAction(
  action: Action,
  config: Record<string, unknown>,
  labels: Label[],
  userMap: Map<string, string>,
): string {
  switch (action) {
    case 'set_priority': return `priority → ${config.priority}`;
    case 'set_assignee': {
      const u = config.assigneeUserId as string;
      return `assign to ${userMap.get(u) ?? '…'}`;
    }
    case 'add_label': {
      const l = labels.find((x) => x.id === config.labelId);
      return l ? `add label "${l.name}"` : 'add label';
    }
    case 'remove_label': {
      const l = labels.find((x) => x.id === config.labelId);
      return l ? `remove label "${l.name}"` : 'remove label';
    }
    case 'transition_status': return `move to ${config.status}`;
    case 'add_comment': return 'post a comment';
    case 'add_watcher': return `add watcher ${userMap.get(config.userId as string) ?? '…'}`;
    case 'notify_user': return `notify ${userMap.get(config.userId as string) ?? '…'}`;
    case 'set_due_date': return `set due date +${config.offsetDays}d`;
    case 'set_sprint': return config.sprintId ? 'move to sprint' : 'remove from sprint';
    default: return action;
  }
}

export function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.problem.detail) return err.problem.detail;
    if (err.problem.title) return err.problem.title;
  }
  return fallback;
}

export function defaultConfigForAction(action: Action, statuses: string[]): Record<string, unknown> {
  switch (action) {
    case 'set_priority': return { priority: 'High' };
    case 'transition_status': return { status: statuses[0] };
    case 'add_comment': return { body: '' };
    case 'set_due_date': return { offsetDays: 7 };
    case 'set_sprint': return { sprintId: null };
    default: return {};
  }
}
