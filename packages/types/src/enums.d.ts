export declare const CompanyRole: {
    readonly Admin: "Admin";
    readonly Member: "Member";
};
export type CompanyRole = (typeof CompanyRole)[keyof typeof CompanyRole];
export declare const ProjectRole: {
    readonly Manager: "Manager";
    readonly Contributor: "Contributor";
    readonly Viewer: "Viewer";
    readonly Client: "Client";
};
export type ProjectRole = (typeof ProjectRole)[keyof typeof ProjectRole];
export declare const ProjectVisibility: {
    readonly Public: "public";
    readonly Teams: "teams";
    readonly Private: "private";
};
export type ProjectVisibility = (typeof ProjectVisibility)[keyof typeof ProjectVisibility];
export declare const WorkflowPreset: {
    readonly Engineering: "engineering";
    readonly Design: "design";
    readonly Generic: "generic";
};
export type WorkflowPreset = (typeof WorkflowPreset)[keyof typeof WorkflowPreset];
export declare const WorkflowStatus: {
    readonly Todo: "Todo";
    readonly InProgress: "In Progress";
    readonly InReview: "In Review";
    readonly Testing: "Testing";
    readonly Done: "Done";
    readonly Approved: "Approved";
};
export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus];
export declare const WORKFLOW_STATUSES: Record<WorkflowPreset, WorkflowStatus[]>;
export declare const Priority: {
    readonly Low: "Low";
    readonly Medium: "Medium";
    readonly High: "High";
    readonly Critical: "Critical";
};
export type Priority = (typeof Priority)[keyof typeof Priority];
export declare const Visibility: {
    readonly Internal: "internal";
    readonly ClientVisible: "client_visible";
};
export type Visibility = (typeof Visibility)[keyof typeof Visibility];
export declare const EventVisibility: {
    readonly Public: "public";
    readonly Internal: "internal";
    readonly AdminOnly: "admin_only";
};
export type EventVisibility = (typeof EventVisibility)[keyof typeof EventVisibility];
export declare const SprintState: {
    readonly Planned: "planned";
    readonly Active: "active";
    readonly Completed: "completed";
};
export type SprintState = (typeof SprintState)[keyof typeof SprintState];
export declare const TaskLinkType: {
    readonly Blocks: "blocks";
    readonly Related: "related";
    readonly Duplicate: "duplicate";
};
export type TaskLinkType = (typeof TaskLinkType)[keyof typeof TaskLinkType];
export declare const AttachmentParentType: {
    readonly Task: "Task";
    readonly Comment: "Comment";
    readonly BugReport: "BugReport";
};
export type AttachmentParentType = (typeof AttachmentParentType)[keyof typeof AttachmentParentType];
export declare const ScanStatus: {
    readonly Pending: "pending";
    readonly Clean: "clean";
    readonly Infected: "infected";
};
export type ScanStatus = (typeof ScanStatus)[keyof typeof ScanStatus];
export declare const DeploymentStatus: {
    readonly Started: "started";
    readonly Succeeded: "succeeded";
    readonly Failed: "failed";
    readonly RolledBack: "rolled_back";
};
export type DeploymentStatus = (typeof DeploymentStatus)[keyof typeof DeploymentStatus];
export declare const DeploymentSource: {
    readonly Vercel: "vercel";
    readonly Railway: "railway";
    readonly GithubActions: "github_actions";
    readonly Docker: "docker";
    readonly Generic: "generic";
};
export type DeploymentSource = (typeof DeploymentSource)[keyof typeof DeploymentSource];
export declare const NotificationChannel: {
    readonly InApp: "in_app";
    readonly Chat: "chat";
};
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];
export declare const UserKind: {
    readonly Internal: "internal";
    readonly Client: "client";
};
export type UserKind = (typeof UserKind)[keyof typeof UserKind];
//# sourceMappingURL=enums.d.ts.map