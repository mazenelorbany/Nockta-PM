import type { Priority, TaskType } from '../task-bits';

export type Preset = 'engineering' | 'design' | 'generic';
export type LinkType = 'blocks' | 'related' | 'duplicate';

// =============================================================================
// Types — what /tasks/:id returns (extended to include relations the API gives
// us via the Prisma include in tasks.service.ts).
// =============================================================================

export interface SubtaskLite {
  id: string;
  title: string;
  status: string;
  type?: TaskType;
  keyNumber: number;
}

export interface ParentLite {
  id: string;
  title: string;
  type: TaskType;
  keyNumber: number;
}

export interface TaskLink {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  type: LinkType;
  createdAt: string;
}

export interface TaskDetail {
  id: string;
  key: string;
  type: TaskType;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: Priority;
  /** AI-set rationale for the priority. Null if a human picked the priority
   *  (humans set priority without going through the auto-prioritization
   *  path). When non-null the priority picker shows a "Why?" tooltip. */
  aiPriorityReason: string | null;
  /** Structured per-factor breakdown for the AI · why? tooltip. Rendered as
   *  a small table when present; falls back to the plain rationale string
   *  otherwise. Older tasks created before factor capture have this null. */
  aiPriorityFactors: Array<{
    name: string;
    weight: number;
    value: number;
    contribution: number;
  }> | null;
  /** 2-3 sentence triage explanation written by the auto-prioritization
   *  processor. Rendered below the factors table inside AiWhyChip — gives
   *  the user a defensible audit trail in prose form. Null on older tasks
   *  prioritized before the triage-explanation pass. */
  aiTriageExplanation: string | null;
  isBlocked: boolean;
  blockedReason: string | null;
  reporterUserId: string;
  assigneeUserId: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimate: number | null;
  visibility: 'internal' | 'client_visible';
  reportedByClient: boolean;
  parentTaskId: string | null;
  sprintId: string | null;
  createdAt: string;
  updatedAt: string;
  project: { id: string; key: string; workflowPreset: Preset };
  parent?: ParentLite | null;
  subtasks?: SubtaskLite[];
  fromLinks?: TaskLink[];
  toLinks?: TaskLink[];
}

export interface Comment {
  id: string;
  bodyMd: string;
  createdAt: string;
  authorUserId: string;
  editLockedAt: string | null;
  author?: { id: string; name: string; avatarUrl?: string | null };
  /** Grouped reactions returned by listByTask. Empty array = no reactions. */
  reactions?: Array<{ emoji: string; count: number; youReacted: boolean }>;
  /** Number of revisions (edits) this comment has. 0 = unedited. */
  editedCount?: number;
  /** Selection-threading: the quoted excerpt this comment renders at the top. */
  quotedSnippet?: {
    commentId: string;
    author: { id: string; name: string; avatarUrl: string | null } | null;
    excerpt: string;
    deleted: boolean;
  } | null;
}

export interface CommentRevisionRow {
  id: string;
  bodyMd: string;
  editedAt: string;
  editedBy?: { id: string; name: string; avatarUrl?: string | null } | null;
}

export type ReactionEmoji = 'thumbsup' | 'thumbsdown' | 'heart' | 'laugh' | 'celebrate' | 'eyes';

export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

export interface UserListResponse {
  items: User[];
  nextCursor: string | null;
}

export interface Attachment {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: 'pending' | 'clean' | 'infected';
  createdAt: string;
  uploader?: { id: string; name: string };
}

export interface TimelineEvent {
  id: string;
  type: string;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  actor?: { id: string; name: string } | null;
}

export interface Label {
  id: string;
  projectId: string;
  name: string;
  color: string;
}

export interface WorklogEntry {
  id: string;
  seconds: number;
  startedAt: string;
  endedAt: string | null;
  note: string | null;
}

export interface WorklogSummary {
  entries: WorklogEntry[];
  totalSeconds: number;
  running: WorklogEntry | null;
}

export interface CustomFieldOption {
  value: string;
  label: string;
  color?: string;
}

export interface CustomFieldRollupConfig {
  relation: 'subtasks' | 'linkedTasks';
  /** Built-in column name ('estimate' | 'storyPoints') or a sibling
   *  custom-field name. */
  field: string;
  agg: 'sum' | 'avg' | 'min' | 'max' | 'count';
}

export interface CustomFieldVisibilityRule {
  when: {
    fieldKey: string;
    op: 'equals' | 'in' | 'isSet';
    value?: unknown;
  };
}

export interface CustomFieldDef {
  id: string;
  name: string;
  kind:
    | 'text'
    | 'number'
    | 'select'
    | 'multiselect'
    | 'date'
    | 'url'
    | 'checkbox'
    | 'formula'
    | 'rollup';
  options: CustomFieldOption[];
  required: boolean;
  position: number;
  /** Present for kind='formula'. NULL otherwise. */
  formulaExpression?: string | null;
  /** Present for kind='rollup'. NULL otherwise. */
  rollupConfig?: CustomFieldRollupConfig | null;
  /** NULL = always visible. */
  visibilityRule?: CustomFieldVisibilityRule | null;
}

export interface CustomFieldValueRow {
  id: string;
  fieldId: string;
  value: unknown;
  field: CustomFieldDef;
  /** Server flag — true for formula/rollup rows (computed at fetch time).
   *  Used by the row renderer to show a read-only display + fx/Σ prefix. */
  computed?: boolean;
}

export interface SimilarTask {
  taskId: string;
  key: string;
  title: string;
  status: string;
  score: number;
}

export interface Recurrence {
  id: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  weekdays: number[];
  dayOfMonth: number | null;
  timezone: string;
  nextRunAt: string;
  lastRunAt: string | null;
  enabled: boolean;
  endsAt: string | null;
}
