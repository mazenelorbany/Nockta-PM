import type { Priority } from '../../components/task-bits';

import type { MyTask } from './types';

export function startOfToday(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const PRIORITY_ORDER: Record<Priority, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
export function byPriorityThenDue(a: MyTask, b: MyTask): number {
  const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  if (p !== 0) return p;
  if (!a.dueDate || !b.dueDate) return 0;
  return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function todayLabel(locale?: string): string {
  // Pass the resolved locale so the long weekday + short month respect the
  // user's selected language. Passing `undefined` makes Intl use the
  // browser-default — fine in EN but wrong if they've switched to ES/AR.
  return new Date().toLocaleDateString(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

export function prettyEvent(t: string): string {
  return t.replace(/[._]/g, ' ').toLowerCase();
}

export function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = 60_000, h = 60 * m, d = 24 * h;
  if (diff < m) return 'just now';
  if (diff < h) return `${Math.floor(diff / m)}m ago`;
  if (diff < d) return `${Math.floor(diff / h)}h ago`;
  if (diff < 7 * d) return `${Math.floor(diff / d)}d ago`;
  // Fallback to the user's active locale (rather than browser-default) so a
  // user who switched to ES sees a Spanish date here.
  // We can't use the hook outside of a component; reading undefined at
  // call time keeps this pure-ish and dependency-free.
  return new Date(iso).toLocaleDateString(
    (typeof document !== 'undefined' && document.documentElement.lang) || undefined,
  );
}
