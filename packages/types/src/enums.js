"use strict";
// =============================================================================
// Enums — canonical strings used across DB, API, and clients.
// Keep in sync with prisma/schema.prisma.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserKind = exports.NotificationChannel = exports.DeploymentSource = exports.DeploymentStatus = exports.ScanStatus = exports.AttachmentParentType = exports.TaskLinkType = exports.SprintState = exports.EventVisibility = exports.Visibility = exports.Priority = exports.WORKFLOW_STATUSES = exports.WorkflowStatus = exports.WorkflowPreset = exports.ProjectVisibility = exports.ProjectRole = exports.CompanyRole = void 0;
exports.CompanyRole = {
    Admin: 'Admin',
    Member: 'Member',
};
exports.ProjectRole = {
    Manager: 'Manager',
    Contributor: 'Contributor',
    Viewer: 'Viewer',
    Client: 'Client',
};
exports.ProjectVisibility = {
    Public: 'public',
    Teams: 'teams',
    Private: 'private',
};
exports.WorkflowPreset = {
    Engineering: 'engineering',
    Design: 'design',
    Generic: 'generic',
};
// Status values per workflow preset.
exports.WorkflowStatus = {
    // Engineering
    Todo: 'Todo',
    InProgress: 'In Progress',
    InReview: 'In Review',
    Testing: 'Testing',
    Done: 'Done',
    // Design adds:
    Approved: 'Approved',
};
exports.WORKFLOW_STATUSES = {
    engineering: ['Todo', 'In Progress', 'In Review', 'Testing', 'Done'],
    design: ['Todo', 'In Progress', 'In Review', 'Approved', 'Done'],
    generic: ['Todo', 'In Progress', 'Done'],
};
exports.Priority = {
    Low: 'Low',
    Medium: 'Medium',
    High: 'High',
    Critical: 'Critical',
};
exports.Visibility = {
    Internal: 'internal',
    ClientVisible: 'client_visible',
};
exports.EventVisibility = {
    Public: 'public',
    Internal: 'internal',
    AdminOnly: 'admin_only',
};
exports.SprintState = {
    Planned: 'planned',
    Active: 'active',
    Completed: 'completed',
};
exports.TaskLinkType = {
    Blocks: 'blocks',
    Related: 'related',
    Duplicate: 'duplicate',
};
exports.AttachmentParentType = {
    Task: 'Task',
    Comment: 'Comment',
    BugReport: 'BugReport',
};
exports.ScanStatus = {
    Pending: 'pending',
    Clean: 'clean',
    Infected: 'infected',
};
exports.DeploymentStatus = {
    Started: 'started',
    Succeeded: 'succeeded',
    Failed: 'failed',
    RolledBack: 'rolled_back',
};
exports.DeploymentSource = {
    Vercel: 'vercel',
    Railway: 'railway',
    GithubActions: 'github_actions',
    Docker: 'docker',
    Generic: 'generic',
};
exports.NotificationChannel = {
    InApp: 'in_app',
    Chat: 'chat',
};
exports.UserKind = {
    Internal: 'internal',
    Client: 'client',
};
//# sourceMappingURL=enums.js.map