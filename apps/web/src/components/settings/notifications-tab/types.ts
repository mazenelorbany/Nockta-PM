// =============================================================================
// Shared types for the NotificationsTab sub-components.
// =============================================================================

export interface NotificationPref {
  id: string;
  userId: string;
  channel: 'in_app' | 'chat';
  eventType: string;
  enabled: boolean;
  snoozeUntil: string | null;
  digestMode: boolean;
  projectId: string | null;
}

export const NOTIFICATION_EVENTS = [
  { type: 'TaskAssigned',       label: 'Task assigned to me' },
  { type: 'TaskUpdated',        label: 'Watched task updated' },
  { type: 'TaskStatusChanged',  label: 'Watched task status changed' },
  { type: 'TaskBlocked',        label: 'Watched task blocked' },
  { type: 'CommentAdded',       label: 'Comment on watched task' },
  { type: 'MentionedInComment', label: '@mention in comment' },
  { type: 'SprintStarted',      label: 'Sprint started' },
  { type: 'SprintCompleted',    label: 'Sprint completed' },
  { type: 'DeploymentFailed',   label: 'Deployment failed' },
  { type: 'ClientReportedBug',  label: 'Client reported a bug' },
];

export const ISO_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type IsoDay = (typeof ISO_DAYS)[number];

export interface SnoozeRule {
  id: string;
  daysOfWeek: IsoDay[];
  startHour: number;
  endHour: number;
  enabled: boolean;
}

export interface DigestPreferences {
  enabled: boolean;
  channel: 'email' | 'chat';
  preview: {
    totalCount: number;
    grouped: Record<string, number>;
    firstQueuedAt: string;
    sentAt: string | null;
  } | null;
}
