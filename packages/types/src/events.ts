// =============================================================================
// Domain event payloads.
// Every mutation in the API emits one of these. They drive: events table,
// notification pipeline, realtime broadcast, audit log.
// =============================================================================

import type { EventVisibility, Priority, Visibility, WorkflowStatus } from './enums';

export interface BaseEvent {
  /** ULID/UUID — server generated. */
  id: string;
  /** Event type tag — see EventType union below. */
  type: EventType;
  /** Actor user id; null for system-emitted events. */
  actorUserId: string | null;
  /** Entity type the event is primarily about. */
  entityType: 'Task' | 'Project' | 'Sprint' | 'Comment' | 'User' | 'Team' | 'Integration' | 'Deployment' | 'Attachment';
  entityId: string;
  /** Optional project scope — denormalized for query speed. */
  projectId: string | null;
  visibility: EventVisibility;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type EventType =
  // Task lifecycle
  | 'TaskCreated'
  | 'TaskUpdated'
  | 'TaskStatusChanged'
  | 'TaskAssigned'
  | 'TaskUnassigned'
  | 'TaskBlocked'
  | 'TaskUnblocked'
  | 'TaskMovedToSprint'
  | 'TaskKeyLinked'      // commit/PR references this task
  | 'TaskDeleted'
  // Subtask / link
  | 'SubtaskAdded'
  | 'TaskLinkCreated'
  | 'TaskLinkRemoved'
  // Comment
  | 'CommentAdded'
  | 'CommentEdited'
  | 'CommentDeleted'
  | 'MentionedInComment'
  // Attachment
  | 'AttachmentUploaded'
  | 'AttachmentDeleted'
  | 'AttachmentInfected'
  // Sprint
  | 'SprintCreated'
  | 'SprintStarted'
  | 'SprintCompleted'
  | 'SprintDeleted'
  // Project / team
  | 'ProjectCreated'
  | 'ProjectArchived'
  | 'ProjectDeleted'
  | 'ProjectVisibilityChanged'
  | 'ProjectMemberAdded'
  | 'ProjectMemberRemoved'
  | 'TeamCreated'
  | 'TeamDeleted'
  | 'TeamMemberAdded'
  | 'TeamMemberRemoved'
  // Integrations
  | 'GitHubAppInstalled'
  | 'GitHubAppUninstalled'
  | 'GitHubWebhookReceived'
  | 'PRLinked'
  | 'PRMerged'
  | 'PRClosed'
  | 'CommitLinked'
  | 'ChatBound'
  | 'ChatUnbound'
  // Deployments
  | 'DeploymentStarted'
  | 'DeploymentSucceeded'
  | 'DeploymentFailed'
  | 'RollbackTriggered'
  | 'ProductionReleaseTagged'
  // Client
  | 'ClientReportedBug'
  | 'ClientApprovedTask'
  // Security / admin
  | 'UserLogin'
  | 'UserLoginFailed'
  | 'PermissionDenied'
  | 'RoleChanged'
  | 'IntegrationConnected'
  | 'WebhookSignatureFailed'
  | 'SecretRotated'
  | 'ExportDataDownloaded';

// Concrete payload shapes for the most-used events.
// Add as new event types are wired.

export interface TaskCreatedPayload {
  taskId: string;
  key: string;
  title: string;
  status: WorkflowStatus;
  priority: Priority;
  visibility: Visibility;
  assigneeUserId: string | null;
  reporterUserId: string;
  projectId: string;
}

export interface TaskStatusChangedPayload {
  taskId: string;
  fromStatus: WorkflowStatus;
  toStatus: WorkflowStatus;
  triggeredBy: 'user' | 'github' | 'deployment' | 'system';
}

export interface CommentAddedPayload {
  commentId: string;
  taskId: string;
  authorUserId: string;
  visibility: Visibility;
  mentions: { userIds: string[]; teamIds: string[] };
  bodyPreview: string;
}

export interface SprintStartedPayload {
  sprintId: string;
  projectId: string;
  name: string;
  startDate: string;
  endDate: string | null;
  taskCount: number;
  estimateSum: number | null;
}

export interface DeploymentSucceededPayload {
  deploymentId: string;
  projectId: string;
  environment: string;
  source: string;
  commitSha: string;
  linkedTaskIds: string[];
}

export interface PRMergedPayload {
  prNumber: number;
  repo: string;
  taskIds: string[];
  authorGithubLogin: string;
  mergedAt: string;
}
