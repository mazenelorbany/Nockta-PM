import type { TaskType } from '../../components/task-bits';

export type Priority = 'Low' | 'Medium' | 'High' | 'Critical';
export type Preset = 'engineering' | 'design' | 'generic';

export interface Task {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  aiRiskReason?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  sprintId?: string | null;
  parentTaskId?: string | null;
  /** Fractional-index key. Used to position cards within a column. */
  boardPosition: string;
  assignee?: { id: string; name: string; avatarUrl?: string };
  labels?: Array<{ label: { id: string; name: string; color: string } }>;
  customFieldValues?: CustomFieldValue[];
}

export interface CustomFieldValue {
  id: string;
  fieldId: string;
  value: unknown;
  field: {
    id: string;
    name: string;
    kind: 'text' | 'number' | 'select' | 'multiselect' | 'date' | 'url' | 'checkbox';
    position: number;
    options: { value: string; label: string; color?: string }[];
  };
}

export interface Project {
  id: string;
  key: string;
  name: string;
  workflowPreset: Preset;
  sprintsEnabled?: boolean;
  /** Caller's effective role on this project, returned by `/projects/:id`.
   *  Drives client-side gating: Viewer hides write affordances entirely
   *  (the API enforces them too; this is just UX so the user isn't
   *  invited into a 403). */
  effectiveRole?: 'Manager' | 'Contributor' | 'Viewer' | 'Client' | null;
}

export interface ActiveSprint {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  state: 'planned' | 'active' | 'completed';
  /** Optional sprint goal/theme — rendered as a banner under the active-sprint
   *  chip on the project board so the team sees their north-star sentence
   *  every time they open the board. */
  goal: string | null;
}

export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}
