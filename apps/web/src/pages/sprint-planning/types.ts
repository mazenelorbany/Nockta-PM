import type { Priority, TaskType } from '../../components/task-bits';

export interface Project {
  id: string;
  key: string;
  name: string;
  sprintsEnabled: boolean;
  workflowPreset: 'engineering' | 'design' | 'generic';
}

export interface Sprint {
  id: string;
  projectId: string;
  name: string;
  state: 'planned' | 'active' | 'completed';
  startDate: string | null;
  endDate: string | null;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface PlannerTask {
  id: string;
  key: string;
  title: string;
  status: string;
  priority: Priority;
  type?: TaskType;
  isBlocked: boolean;
  estimate: number | null;
  dueDate: string | null;
  assignee?: { id: string; name: string; avatarUrl?: string | null } | null;
  labels: Label[];
  _count?: { subtasks: number };
}

export type Side = 'backlog' | 'sprint';
