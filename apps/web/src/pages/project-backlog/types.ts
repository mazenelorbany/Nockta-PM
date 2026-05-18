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
  /** Free-text sprint theme / goal (≤200 chars). Surfaced as a one-line
   *  banner under each sprint header so the goal is visible at all times. */
  goal: string | null;
  _count?: { tasks: number };
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

export type ContainerId = string; // 'backlog' or sprint UUID

export interface RetroResponse {
  id: string;
  whatWentWell: string | null;
  whatCouldImprove: string | null;
  actionItems: Array<{
    id: string;
    description: string;
    ownerUserId: string | null;
    status: 'open' | 'done';
    dueDate: string | null;
  }>;
}

export interface GoalEvalResponse {
  goalAchieved: boolean;
  note: string | null;
}

export interface CapacityResponse {
  suggestedPoints: number;
  lowerBound: number;
  upperBound: number;
  mean: number;
  stddev: number;
  sampleSize: number;
  explanation: string;
}

export interface RankedTaskResponse {
  taskId: string;
  key: string;
  title: string;
  priority: string;
  storyPoints: number;
  ageDays: number;
  score: number;
  why: string;
}

export interface PlanResponse {
  tasks: RankedTaskResponse[];
  usedPoints: number;
  capacity: number;
}
