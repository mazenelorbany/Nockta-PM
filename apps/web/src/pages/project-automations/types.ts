// =============================================================================
// /projects/:projectId/automations — list, create, toggle, and inspect automations.
// =============================================================================

export type Trigger =
  | 'task_created'
  | 'task_status_changed'
  | 'task_assigned'
  | 'task_unassigned'
  | 'task_due_soon'
  | 'task_blocked'
  | 'task_labeled'
  | 'comment_added';

export type Action =
  | 'set_priority'
  | 'set_assignee'
  | 'add_label'
  | 'remove_label'
  | 'transition_status'
  | 'add_comment'
  | 'add_watcher'
  | 'notify_user'
  | 'set_due_date'
  | 'set_sprint'
  | 'send_webhook';

export interface Automation {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: Trigger;
  triggerConfig: Record<string, unknown>;
  action: Action;
  actionConfig: Record<string, unknown>;
  runCount: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string; avatarUrl: string | null };
}

export interface AutomationRun {
  id: string;
  status: 'succeeded' | 'skipped' | 'failed';
  message: string | null;
  payload: Record<string, unknown> | null;
  taskId: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
  sprintsEnabled: boolean;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface ProjectAccessRow {
  id: string;
  user?: { id: string; name: string; email: string } | null;
}

export interface SprintRow {
  id: string;
  name: string;
  state: 'planned' | 'active' | 'completed';
}

export const TRIGGER_OPTIONS: { value: Trigger; label: string; hint: string }[] = [
  { value: 'task_created', label: 'Task created', hint: 'A new task is created in this project' },
  { value: 'task_status_changed', label: 'Status changed', hint: 'A task moves between columns' },
  { value: 'task_assigned', label: 'Task assigned', hint: 'A task gets an assignee' },
  { value: 'task_unassigned', label: 'Task unassigned', hint: 'A task loses its assignee' },
  { value: 'task_blocked', label: 'Task marked blocked', hint: 'Someone flags a task as blocked' },
  { value: 'task_labeled', label: 'Label added', hint: 'A label is attached to a task' },
  { value: 'comment_added', label: 'Comment added', hint: 'Someone comments on a task' },
];

export const ACTION_OPTIONS: { value: Action; label: string }[] = [
  { value: 'set_priority', label: 'Set priority' },
  { value: 'set_assignee', label: 'Set assignee' },
  { value: 'add_label', label: 'Add label' },
  { value: 'remove_label', label: 'Remove label' },
  { value: 'transition_status', label: 'Transition status' },
  { value: 'add_comment', label: 'Post a comment' },
  { value: 'add_watcher', label: 'Add a watcher' },
  { value: 'notify_user', label: 'Notify user' },
  { value: 'set_due_date', label: 'Set due date (offset days)' },
  { value: 'set_sprint', label: 'Move to sprint' },
  { value: 'send_webhook', label: 'Send webhook (HTTP POST)' },
];

export const STATUSES_BY_PRESET: Record<Project['workflowPreset'], string[]> = {
  engineering: ['Backlog', 'In Progress', 'In Review', 'Done'],
  design: ['Idea', 'Designing', 'Review', 'Approved'],
  generic: ['Todo', 'In Progress', 'Done'],
};

export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;
