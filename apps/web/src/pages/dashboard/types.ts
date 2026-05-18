import type { Priority, TaskType } from '../../components/task-bits';

export interface PersonalDashboard {
  openByPriority: { priority: Priority; count: number }[];
  overdueCount: number;
  watchingCount: number;
  mentionsLast7Days: number;
  timeThisWeek?: {
    totalSeconds: number;
    byDay: { day: string; seconds: number }[];
  };
  /** Set when the user has configured a weekly hours target in their
   *  preferences. Null when no target is set — the streak widget hides. */
  weeklyTarget?: {
    hours: number;
    secondsLogged: number;
    secondsTarget: number;
    hit: boolean;
    streakWeeks: number;
  } | null;
}

export interface MyTask {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  dueDate: string | null;
  project?: { id: string; key: string; name: string };
  assignee?: { id: string; name: string } | null;
}

export interface TaskSearchResp {
  items: MyTask[];
  nextCursor: string | null;
}

export interface TimelineEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  actor?: { id: string; name: string } | null;
}
