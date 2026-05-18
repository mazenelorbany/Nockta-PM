import type { Priority } from '../../components/task-bits';

export type GoalStatus = 'active' | 'achieved' | 'dropped';

export interface GoalListItem {
  id: string;
  name: string;
  description: string | null;
  status: GoalStatus;
  progress: number | null;
  startDate: string | null;
  targetDate: string | null;
  createdAt: string;
  owner: { id: string; name: string; email: string; avatarUrl?: string | null };
  _count: { tasks: number };
}

export interface GoalDetail {
  id: string;
  name: string;
  description: string | null;
  status: GoalStatus;
  progress: number | null;
  startDate: string | null;
  targetDate: string | null;
  createdAt: string;
  owner: { id: string; name: string; email: string };
  tasks: {
    task: {
      id: string;
      keyNumber: number;
      title: string;
      status: string;
      priority: Priority;
      isBlocked: boolean;
      dueDate: string | null;
      project: { id: string; key: string; name: string };
      assignee?: { id: string; name: string } | null;
    };
  }[];
}

export interface KeyResult {
  id: string;
  name: string;
  unit: string | null;
  targetValue: number;
  currentValue: number;
  position: number;
}

export interface PickerTask {
  id: string;
  title: string;
  status: string;
  keyNumber: number;
  project: { id: string; key: string; name: string };
}

export interface KeyResultRowCallbacks {
  onUpdate: (id: string, body: Partial<KeyResult>) => void;
  onRemove: (id: string) => void;
}
