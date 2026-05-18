import { BarChart3, Calendar, LayoutDashboard, ListTodo, Settings } from 'lucide-react';
import type { TaskType } from '../task-bits';

export interface SearchTask {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  project?: { id: string; key: string; name: string };
  assignee?: { id: string; name: string } | null;
}
export interface SearchResp { items: SearchTask[]; nextCursor: string | null }
export interface SearchDoc {
  id: string;
  title: string;
  projectId: string;
  projectKey: string;
  projectName: string;
}

export type Hit =
  | { kind: 'task'; data: SearchTask }
  | { kind: 'doc'; data: SearchDoc }
  | { kind: 'route'; data: { id: string; label: string; description: string; to: string; icon: React.ComponentType<{ className?: string }> } }
  | { kind: 'recent'; data: { id: string; label: string; key?: string; to: string; type: 'task' | 'doc' } };

export const RECENTS_KEY = 'nockta:cmdk:recents:v1';
export const RECENTS_MAX = 6;

export interface RecentEntry {
  id: string;
  label: string;
  key?: string;
  to: string;
  type: 'task' | 'doc';
  visitedAt: number;
}

export const QUICK_ROUTES = [
  { id: 'r-dashboard', label: 'Dashboard', description: 'Personal command center', to: '/', icon: LayoutDashboard },
  { id: 'r-mytasks',   label: 'My tasks', description: 'Everything assigned to you', to: '/my-tasks', icon: ListTodo },
  { id: 'r-projects',  label: 'All projects', description: 'Browse the workspace', to: '/projects', icon: LayoutDashboard },
  { id: 'r-calendar',  label: 'Calendar', description: 'Deadlines + sprint dates', to: '/calendar', icon: Calendar },
  { id: 'r-analytics', label: 'Analytics', description: 'Throughput, cycle time, burndown', to: '/analytics', icon: BarChart3 },
  { id: 'r-settings',  label: 'Settings', description: 'Members, projects, integrations', to: '/settings', icon: Settings },
] as const;
