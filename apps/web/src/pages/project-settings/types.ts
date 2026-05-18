// Shared types for ProjectSettingsPage and its sub-section components.

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  visibility: 'public' | 'teams' | 'private';
  workflowPreset: 'engineering' | 'design' | 'generic';
  sprintsEnabled: boolean;
  githubAutoStatus: boolean;
  maxAttachmentMb: number;
  chatSpaceId: string | null;
  chatBroadcastEvents: string[];
  /** When 'client_visible', guests on this project see every task regardless
   *  of the per-task visibility flag, and new tasks default to client-visible. */
  defaultTaskVisibility: 'internal' | 'client_visible';
  archivedAt: string | null;
}

export interface Access {
  id: string;
  subjectKind: 'user' | 'team';
  userId: string | null;
  teamId: string | null;
  role: 'Manager' | 'Contributor' | 'Viewer' | 'Client';
  user?: { id: string; name: string; email: string } | null;
  team?: { id: string; slug: string; name: string } | null;
}

export type ProjectRole = 'Manager' | 'Contributor' | 'Viewer' | 'Client';
export type SubjectKind = 'user' | 'team';

export interface AccessUserOption {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  kind: 'internal' | 'client';
}

export interface AccessTeamOption {
  id: string;
  name: string;
  slug: string;
}

export type FieldKind =
  | 'text'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'url'
  | 'checkbox'
  | 'formula'
  | 'rollup';

export interface RollupConfig {
  relation: 'subtasks' | 'linkedTasks';
  field: string;
  agg: 'sum' | 'avg' | 'min' | 'max' | 'count';
}

export interface VisibilityRule {
  when: {
    fieldKey: string;
    op: 'equals' | 'in' | 'isSet';
    value?: unknown;
  };
}

export interface CustomFieldDef {
  id: string;
  name: string;
  kind: FieldKind;
  options: { value: string; label: string; color?: string }[];
  required: boolean;
  position: number;
  formulaExpression?: string | null;
  rollupConfig?: RollupConfig | null;
  visibilityRule?: VisibilityRule | null;
}

export interface TaskTemplate {
  id: string;
  name: string;
  description: string | null;
  titleTemplate: string;
  bodyTemplate: string | null;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  estimate: number | null;
  defaultStatus: string | null;
  labelIds: string[];
}
