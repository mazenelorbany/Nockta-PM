import { Link } from 'react-router-dom';
import { ArrowRight, Flame, ListChecks } from 'lucide-react';
import { cn } from '@nockta/ui';

import { projectAccent } from '../../components/layout/project-tree-item';

import { startOfToday } from './helpers';
import type { MyTask } from './types';

// =============================================================================
// MyProjects — horizontal strip of the projects the signed-in user has open
// work in, ranked by urgency (overdue → due-today → total open). Sits under
// the greeting hero and above the stat strip so a returning user has a one-
// click path back into the project they were last working on without having
// to detour through `/projects`.
//
// Data source: the same `/search/tasks?assigneeUserId=me` payload the rest of
// the dashboard already loads — we just bucket it by project. This means the
// strip is FREE (no extra API call) and stays in sync with the task lists
// rendered below.
//
// Links emit the slug-based URL (`/projects/<KEY>/board`) so users see a
// clean address bar; the resolver hook on the destination page maps the key
// to the canonical id for any API calls.
// =============================================================================

export interface ProjectBucket {
  id: string;
  key: string;
  name: string;
  totalOpen: number;
  dueToday: number;
  overdue: number;
  blocked: number;
}

/**
 * Bucket the user's open tasks by project. Returns up to `max` projects,
 * ranked by:
 *   1. Overdue tasks (descending) — fire-first.
 *   2. Due-today tasks (descending) — "today's burn list".
 *   3. Total open (descending) — tie-breaker for the rest.
 */
export function bucketTasksByProject(tasks: MyTask[], max = 6): ProjectBucket[] {
  const today = startOfToday();
  const tomorrow = today + 24 * 60 * 60 * 1000;
  const buckets = new Map<string, ProjectBucket>();
  for (const t of tasks) {
    if (!t.project) continue;
    if (t.status.toLowerCase() === 'done') continue;
    let b = buckets.get(t.project.id);
    if (!b) {
      b = {
        id: t.project.id,
        key: t.project.key,
        name: t.project.name,
        totalOpen: 0,
        dueToday: 0,
        overdue: 0,
        blocked: 0,
      };
      buckets.set(t.project.id, b);
    }
    b.totalOpen += 1;
    if (t.dueDate) {
      const ts = new Date(t.dueDate).getTime();
      if (ts < today) b.overdue += 1;
      else if (ts < tomorrow) b.dueToday += 1;
    }
    if (t.isBlocked) b.blocked += 1;
  }
  return Array.from(buckets.values())
    .sort((a, b) => b.overdue - a.overdue || b.dueToday - a.dueToday || b.totalOpen - a.totalOpen)
    .slice(0, max);
}

export function MyProjects({ tasks }: { tasks: MyTask[] }): JSX.Element | null {
  const buckets = bucketTasksByProject(tasks);
  if (buckets.length === 0) return null;
  return (
    <section aria-labelledby="my-projects-heading">
      <header className="flex items-baseline justify-between mb-2">
        <h2 id="my-projects-heading" className="nockta-eyebrow text-muted-foreground">
          Your projects
        </h2>
        <Link
          to="/projects"
          className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 transition-colors"
        >
          All projects
          <ArrowRight className="h-3 w-3" />
        </Link>
      </header>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        {buckets.map((b) => (
          <ProjectShortcut key={b.id} bucket={b} />
        ))}
      </div>
    </section>
  );
}

function ProjectShortcut({ bucket }: { bucket: ProjectBucket }): JSX.Element {
  const accent = projectAccent(bucket.key);
  const urgent = bucket.overdue > 0 || bucket.dueToday > 0;
  return (
    <Link
      to={`/projects/${bucket.key || bucket.id}/board`}
      className={cn(
        'group relative overflow-hidden rounded-lg border bg-card px-3 py-2.5 transition-colors',
        urgent
          ? 'border-status-blocked/30 hover:border-status-blocked/60'
          : 'border-border hover:border-ring',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className="shrink-0 h-6 w-6 rounded-md inline-flex items-center justify-center text-[10px] font-mono font-bold tracking-tight"
          style={{
            background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
            color: accent.fg,
          }}
        >
          {bucket.key.slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-mono text-muted-foreground leading-none">
            {bucket.key}
          </div>
          <div className="text-xs font-medium truncate mt-0.5">{bucket.name}</div>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2 text-[11px] tabular-nums">
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <ListChecks className="h-3 w-3" />
          {bucket.totalOpen}
        </span>
        {bucket.overdue > 0 && (
          <span className="inline-flex items-center gap-1 text-status-blocked font-semibold">
            <Flame className="h-3 w-3" />
            {bucket.overdue}
          </span>
        )}
        {bucket.dueToday > 0 && (
          <span className="text-brand font-semibold">{bucket.dueToday} today</span>
        )}
      </div>
    </Link>
  );
}
