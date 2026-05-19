import type { EventVisibility } from '@prisma/client';

export interface EventMapEntry {
  /** Canonical event type stored in events.type. */
  type: string;
  visibility: EventVisibility;
  entityType: 'Task' | 'Comment' | 'Project' | 'Sprint' | 'User' | 'Team' | 'Integration' | 'Deployment' | 'Attachment';
  /** Key in payload to read entity_id from. */
  entityIdKey: string;
  /** Optional key in payload to read project_id from. */
  projectIdKey?: string;
}

/**
 * Map of `emitter.emit(name, payload)` event names to event-store entries.
 * Unknown event names are silently ignored by the writer.
 */
export const EVENT_MAP: Record<string, EventMapEntry> = {
  // Tasks
  'task.created':         { type: 'TaskCreated',        visibility: 'public', entityType: 'Task',    entityIdKey: 'taskId',    projectIdKey: 'projectId' },
  'task.updated':         { type: 'TaskUpdated',        visibility: 'public', entityType: 'Task',    entityIdKey: 'taskId' },
  'task.status_changed':  { type: 'TaskStatusChanged',  visibility: 'public', entityType: 'Task',    entityIdKey: 'taskId',    projectIdKey: 'projectId' },
  'task.blocked':         { type: 'TaskBlocked',        visibility: 'public', entityType: 'Task',    entityIdKey: 'taskId' },
  'task.unblocked':       { type: 'TaskUnblocked',      visibility: 'public', entityType: 'Task',    entityIdKey: 'taskId' },
  'task.deleted':         { type: 'TaskDeleted',        visibility: 'public', entityType: 'Task',    entityIdKey: 'taskId' },

  // Comments
  'comment.added':           { type: 'CommentAdded',        visibility: 'public', entityType: 'Comment', entityIdKey: 'commentId' },
  'comment.edited':          { type: 'CommentEdited',       visibility: 'public', entityType: 'Comment', entityIdKey: 'commentId' },
  'comment.deleted':         { type: 'CommentDeleted',      visibility: 'public', entityType: 'Comment', entityIdKey: 'commentId' },
  'comment.reaction_added':  { type: 'CommentReactionAdded',   visibility: 'public', entityType: 'Comment', entityIdKey: 'commentId' },
  'comment.reaction_removed':{ type: 'CommentReactionRemoved', visibility: 'public', entityType: 'Comment', entityIdKey: 'commentId' },

  // Projects
  'project.created':            { type: 'ProjectCreated',           visibility: 'internal', entityType: 'Project', entityIdKey: 'projectId', projectIdKey: 'projectId' },
  'project.updated':            { type: 'ProjectVisibilityChanged', visibility: 'internal', entityType: 'Project', entityIdKey: 'projectId', projectIdKey: 'projectId' },
  'project.archived':           { type: 'ProjectArchived',          visibility: 'internal', entityType: 'Project', entityIdKey: 'projectId', projectIdKey: 'projectId' },
  'project.access_granted':     { type: 'ProjectMemberAdded',       visibility: 'internal', entityType: 'Project', entityIdKey: 'projectId', projectIdKey: 'projectId' },
  'project.access_revoked':     { type: 'ProjectMemberRemoved',     visibility: 'internal', entityType: 'Project', entityIdKey: 'projectId', projectIdKey: 'projectId' },
  // Project-scoped invitation. Distinct from access_granted because the
  // invite emits BEFORE the guest has logged in — the activity timeline
  // shows "Alice invited bob@external.test" rather than "Alice added Bob".
  'project.guest_invited':      { type: 'ProjectGuestInvited',      visibility: 'internal', entityType: 'Project', entityIdKey: 'projectId', projectIdKey: 'projectId' },

  // Sprints
  'sprint.created':       { type: 'SprintCreated',     visibility: 'public', entityType: 'Sprint',  entityIdKey: 'sprintId',  projectIdKey: 'projectId' },
  'sprint.started':       { type: 'SprintStarted',     visibility: 'public', entityType: 'Sprint',  entityIdKey: 'sprintId',  projectIdKey: 'projectId' },
  'sprint.completed':     { type: 'SprintCompleted',   visibility: 'public', entityType: 'Sprint',  entityIdKey: 'sprintId',  projectIdKey: 'projectId' },
  'sprint.deleted':       { type: 'SprintDeleted',     visibility: 'public', entityType: 'Sprint',  entityIdKey: 'sprintId',  projectIdKey: 'projectId' },

  // Teams (internal-only — not visible to clients)
  'team.created':         { type: 'TeamCreated',       visibility: 'internal', entityType: 'Team', entityIdKey: 'teamId' },
  'team.deleted':         { type: 'TeamDeleted',       visibility: 'internal', entityType: 'Team', entityIdKey: 'teamId' },
  'team.member_added':    { type: 'TeamMemberAdded',   visibility: 'internal', entityType: 'Team', entityIdKey: 'teamId' },
  'team.member_removed':  { type: 'TeamMemberRemoved', visibility: 'internal', entityType: 'Team', entityIdKey: 'teamId' },

  // Users (security / admin)
  'user.role_changed':    { type: 'RoleChanged',     visibility: 'admin_only', entityType: 'User', entityIdKey: 'userId' },
  'user.archived':        { type: 'RoleChanged',     visibility: 'admin_only', entityType: 'User', entityIdKey: 'userId' },
  'user.login':           { type: 'UserLogin',       visibility: 'admin_only', entityType: 'User', entityIdKey: 'userId' },

  // Auth security
  // `auth.magic_link_sent` is INTENTIONALLY not persisted to Event:
  //   - it fires before the recipient has a User row in the signup case, so
  //     no userId is available and Event.entityId (UUID) can't be populated;
  //   - the verified sign-in already emits `user.login` (with userId) plus an
  //     AuditLog row, which is what admins actually need;
  //   - keeping the emit as a no-mapping signal lets future subscribers
  //     (rate-limit, anomaly detection) attach without ceremony.
  'auth.refresh_reuse':   { type: 'WebhookSignatureFailed', visibility: 'admin_only', entityType: 'User', entityIdKey: 'userId' },

  // GitHub / Chat / Deployment events — populated later as those modules ship
  'github.pr_linked':         { type: 'PRLinked',           visibility: 'public', entityType: 'Task',       entityIdKey: 'taskId',       projectIdKey: 'projectId' },
  'github.pr_merged':         { type: 'PRMerged',           visibility: 'public', entityType: 'Task',       entityIdKey: 'taskId',       projectIdKey: 'projectId' },
  'github.pr_closed':         { type: 'PRClosed',           visibility: 'public', entityType: 'Task',       entityIdKey: 'taskId',       projectIdKey: 'projectId' },
  'github.commit_linked':     { type: 'CommitLinked',       visibility: 'public', entityType: 'Task',       entityIdKey: 'taskId',       projectIdKey: 'projectId' },
  // github.app_installed / uninstalled fire with `installationId` (numeric
  // string from GitHub, e.g. "12345"), which can't go in Event.entityId (UUID).
  // Re-enable when we look up the internal GitHubInstallation.id (UUID) and
  // pass it as entityId at emit time; until then the emits are unmapped.

  'chat.bound':               { type: 'ChatBound',          visibility: 'internal', entityType: 'User', entityIdKey: 'userId' },
  'chat.unbound':             { type: 'ChatUnbound',        visibility: 'internal', entityType: 'User', entityIdKey: 'userId' },

  'deploy.started':           { type: 'DeploymentStarted',  visibility: 'public', entityType: 'Deployment', entityIdKey: 'deploymentId', projectIdKey: 'projectId' },
  'deploy.succeeded':         { type: 'DeploymentSucceeded',visibility: 'public', entityType: 'Deployment', entityIdKey: 'deploymentId', projectIdKey: 'projectId' },
  'deploy.failed':            { type: 'DeploymentFailed',   visibility: 'public', entityType: 'Deployment', entityIdKey: 'deploymentId', projectIdKey: 'projectId' },
  'deploy.rolled_back':       { type: 'RollbackTriggered',  visibility: 'public', entityType: 'Deployment', entityIdKey: 'deploymentId', projectIdKey: 'projectId' },
  'deploy.production_release':{ type: 'ProductionReleaseTagged', visibility: 'public', entityType: 'Deployment', entityIdKey: 'deploymentId', projectIdKey: 'projectId' },

  // Attachments
  'attachment.uploaded':  { type: 'AttachmentUploaded', visibility: 'public', entityType: 'Attachment', entityIdKey: 'attachmentId', projectIdKey: 'projectId' },
  'attachment.deleted':   { type: 'AttachmentDeleted',  visibility: 'public', entityType: 'Attachment', entityIdKey: 'attachmentId', projectIdKey: 'projectId' },
  'attachment.infected':  { type: 'AttachmentInfected', visibility: 'admin_only', entityType: 'Attachment', entityIdKey: 'attachmentId' },

  // Client
  'client.reported_bug':  { type: 'ClientReportedBug', visibility: 'public', entityType: 'Task', entityIdKey: 'taskId', projectIdKey: 'projectId' },
  'client.approved_task': { type: 'ClientApprovedTask',visibility: 'public', entityType: 'Task', entityIdKey: 'taskId', projectIdKey: 'projectId' },
};
