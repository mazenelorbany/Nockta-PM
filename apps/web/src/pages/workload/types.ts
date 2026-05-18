import type { Priority } from '../../components/task-bits';

// =============================================================================
// Shared types for the WorkloadPage sub-components.
// =============================================================================

export interface WorkloadRow {
  userId: string;
  total: number;
  points: number;
  byPriority: { Critical: number; High: number; Medium: number; Low: number };
  loadScore: number;
  user: { id: string; name: string; email: string; avatarUrl: string | null } | null;
  /** Open-task count snapshot for each of the last 7 days (oldest → newest). */
  series?: number[];
}

export interface WorkloadResp {
  rows: WorkloadRow[];
}

export interface ProjectLite { id: string; key: string; name: string }
export interface TeamLite { id: string; name: string; slug: string }

export interface WorkloadDetailResp {
  user: { id: string; name: string; email: string; avatarUrl: string | null } | null;
  summary: {
    total: number;
    points: number;
    loadScore: number;
    byPriority: { Critical: number; High: number; Medium: number; Low: number };
  };
  byStatus: { status: string; count: number }[];
  overdueCount: number;
  dueSoonCount: number;
  openTasks: {
    id: string;
    keyNumber: number;
    title: string;
    status: string;
    priority: Priority;
    isBlocked: boolean;
    dueDate: string | null;
    estimate: number | null;
    project: { id: string; key: string; name: string };
  }[];
  completionTrend: { date: string; completed: number }[];
}

export interface ProjectGroup {
  project: { id: string; key: string; name: string };
  tasks: WorkloadDetailResp['openTasks'];
}
