// =============================================================================
// Enums — canonical strings used across DB, API, and clients.
// Keep in sync with prisma/schema.prisma.
// =============================================================================

export const CompanyRole = {
  Admin: 'Admin',
  Member: 'Member',
} as const;
export type CompanyRole = (typeof CompanyRole)[keyof typeof CompanyRole];

export const ProjectRole = {
  Manager: 'Manager',
  Contributor: 'Contributor',
  Viewer: 'Viewer',
  Client: 'Client',
} as const;
export type ProjectRole = (typeof ProjectRole)[keyof typeof ProjectRole];

export const ProjectVisibility = {
  Public: 'public',
  Teams: 'teams',
  Private: 'private',
} as const;
export type ProjectVisibility = (typeof ProjectVisibility)[keyof typeof ProjectVisibility];

export const WorkflowPreset = {
  Engineering: 'engineering',
  Design: 'design',
  Generic: 'generic',
} as const;
export type WorkflowPreset = (typeof WorkflowPreset)[keyof typeof WorkflowPreset];

// Status values per workflow preset.
export const WorkflowStatus = {
  // Engineering
  Todo: 'Todo',
  InProgress: 'In Progress',
  InReview: 'In Review',
  Testing: 'Testing',
  Done: 'Done',
  // Design adds:
  Approved: 'Approved',
} as const;
export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus];

export const WORKFLOW_STATUSES: Record<WorkflowPreset, WorkflowStatus[]> = {
  engineering: ['Todo', 'In Progress', 'In Review', 'Testing', 'Done'],
  design: ['Todo', 'In Progress', 'In Review', 'Approved', 'Done'],
  generic: ['Todo', 'In Progress', 'Done'],
};

export const Priority = {
  Low: 'Low',
  Medium: 'Medium',
  High: 'High',
  Critical: 'Critical',
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export const Visibility = {
  Internal: 'internal',
  ClientVisible: 'client_visible',
} as const;
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

export const EventVisibility = {
  Public: 'public',
  Internal: 'internal',
  AdminOnly: 'admin_only',
} as const;
export type EventVisibility = (typeof EventVisibility)[keyof typeof EventVisibility];

export const SprintState = {
  Planned: 'planned',
  Active: 'active',
  Completed: 'completed',
} as const;
export type SprintState = (typeof SprintState)[keyof typeof SprintState];

export const TaskLinkType = {
  Blocks: 'blocks',
  Related: 'related',
  Duplicate: 'duplicate',
} as const;
export type TaskLinkType = (typeof TaskLinkType)[keyof typeof TaskLinkType];

export const AttachmentParentType = {
  Task: 'Task',
  Comment: 'Comment',
  BugReport: 'BugReport',
} as const;
export type AttachmentParentType =
  (typeof AttachmentParentType)[keyof typeof AttachmentParentType];

export const ScanStatus = {
  Pending: 'pending',
  Clean: 'clean',
  Infected: 'infected',
} as const;
export type ScanStatus = (typeof ScanStatus)[keyof typeof ScanStatus];

export const DeploymentStatus = {
  Started: 'started',
  Succeeded: 'succeeded',
  Failed: 'failed',
  RolledBack: 'rolled_back',
} as const;
export type DeploymentStatus = (typeof DeploymentStatus)[keyof typeof DeploymentStatus];

export const DeploymentSource = {
  Vercel: 'vercel',
  Railway: 'railway',
  GithubActions: 'github_actions',
  Docker: 'docker',
  Generic: 'generic',
} as const;
export type DeploymentSource = (typeof DeploymentSource)[keyof typeof DeploymentSource];

export const NotificationChannel = {
  InApp: 'in_app',
  Chat: 'chat',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const UserKind = {
  Internal: 'internal',
  Client: 'client',
} as const;
export type UserKind = (typeof UserKind)[keyof typeof UserKind];
