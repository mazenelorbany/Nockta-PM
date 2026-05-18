import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight, BarChart3, FileText, Flame, Inbox, LayoutDashboard,
  Settings, Sparkles, Target, Timer, Zap,
} from 'lucide-react';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cn } from '@nockta/ui';

import {
  AvatarCircle,
  type Priority,
  type TaskType,
} from '../components/task-bits';
import { api } from '../lib/api';
import { ProjectTabs } from '../components/ProjectTabs';
import { queryKeys } from '../lib/query-keys';

// =============================================================================
// /projects/:projectId — the project's home page. Replaces the old "click =
// dropdown" sidebar pattern: clicking a project in the sidebar now lands here
// with a hero, stats, sprint progress, recent activity, and quick-link cards
// to every sub-view (Board, List, Backlog, Timeline, Sprints, Docs, etc).
// =============================================================================

interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  workflowPreset: 'engineering' | 'design' | 'generic';
  sprintsEnabled: boolean;
  archivedAt: string | null;
  createdAt: string;
}

interface Task {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  dueDate: string | null;
  parentTaskId?: string | null;
  assignee?: { id: string; name: string; avatarUrl?: string | null };
}

interface SprintRow {
  id: string;
  name: string;
  state: 'planned' | 'active' | 'completed';
  startDate: string | null;
  endDate: string | null;
  _count?: { tasks: number };
}

interface AccessRow {
  id: string;
  user?: { id: string; name: string; email: string; avatarUrl: string | null } | null;
  team?: { id: string; name: string; slug: string } | null;
  role: string;
}

interface TimelineEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  actor?: { id: string; name: string; avatarUrl: string | null } | null;
}

export function ProjectOverviewPage(): JSX.Element {
  const { projectId = '' } = useParams<{ projectId: string }>();

  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const tasksQuery = useQuery({
    queryKey: queryKeys.projectTasks(projectId),
    queryFn: () => api.get<Task[]>(`/tasks/project/${projectId}`),
    enabled: Boolean(projectId),
  });
  const sprintsQuery = useQuery({
    queryKey: queryKeys.sprints(projectId),
    queryFn: () => api.get<SprintRow[]>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId),
  });
  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => api.get<AccessRow[]>(`/projects/${projectId}/access`),
    enabled: Boolean(projectId),
  });
  const activityQuery = useQuery({
    queryKey: ['project-timeline', projectId],
    queryFn: () =>
      api.get<{ items: TimelineEvent[]; nextCursor: string | null }>(
        `/timeline/project/${projectId}?limit=10`,
      ),
    enabled: Boolean(projectId),
  });

  const project = projectQuery.data;
  const tasks = tasksQuery.data ?? [];

  // Top-level tasks only — exclude subtasks from the stat counts so the same
  // "shape" you see on the board matches the numbers here.
  const topLevel = useMemo(() => tasks.filter((t) => !t.parentTaskId), [tasks]);

  const stats = useMemo(() => {
    const total = topLevel.length;
    const inProgress = topLevel.filter((t) => /progress|designing|review|testing/i.test(t.status)).length;
    const blocked = topLevel.filter((t) => t.isBlocked).length;
    const overdue = topLevel.filter((t) => t.dueDate && new Date(t.dueDate) < new Date() && !/done|approved/i.test(t.status)).length;
    const done = topLevel.filter((t) => /done|approved/i.test(t.status)).length;
    const open = total - done;
    return { total, open, inProgress, blocked, overdue, done };
  }, [topLevel]);

  const activeSprint = (sprintsQuery.data ?? []).find((s) => s.state === 'active') ?? null;
  const accessMembers = (accessQuery.data ?? []).filter((a) => a.user).map((a) => a.user!).slice(0, 20);
  const recent = (activityQuery.data?.items ?? []).slice(0, 8);

  if (!project) {
    return <div className="p-4 sm:p-6 md:p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Hero — cinematic, brand gradient, oversized watermark, type-driven */}
      <header className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-brand-gradient pointer-events-none" />
        <div
          className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
            backgroundSize: '64px 64px',
          }}
        />
        {/* Brand cube — "connect" (Bringing the Pieces) sits bottom-right
            of the project hero. The cube faces tilt away from the type so
            the headline stays the primary read. */}
        <img
          src="/connect.png"
          alt=""
          aria-hidden="true"
          className="absolute -right-16 -bottom-16 h-[420px] w-[420px] object-contain pointer-events-none select-none opacity-60"
        />

        <div className="relative px-4 sm:px-6 md:px-10 pt-6 pb-8 sm:pt-10 sm:pb-12 md:pt-14 md:pb-16">
          <div className="flex items-center gap-2 sm:gap-3 mb-3 flex-wrap">
            <span className="font-mono text-[11px] tracking-[0.2em] uppercase text-brand bg-brand/10 border border-brand/20 rounded-md px-2 py-1">
              {project.key}
            </span>
            <span className={cn(
              'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded',
              project.workflowPreset === 'engineering' && 'bg-brand/15 text-brand',
              project.workflowPreset === 'design' && 'bg-status-in-review/15 text-status-in-review',
              project.workflowPreset === 'generic' && 'bg-muted text-muted-foreground',
            )}>
              {project.workflowPreset}
            </span>
            {project.sprintsEnabled && (
              <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-secondary/60 text-muted-foreground">
                sprints on
              </span>
            )}
          </div>
          <h1
            className="display-heading leading-[1.04] max-w-4xl"
            style={{ fontSize: 'clamp(2rem, 4.4vw, 3.6rem)' }}
          >
            {project.name}
          </h1>
          {project.description && (
            <p className="mt-5 text-base text-muted-foreground max-w-2xl leading-relaxed">
              {project.description}
            </p>
          )}

          {/* Member avatars */}
          {accessMembers.length > 0 && (
            <div className="mt-6 flex items-center gap-2">
              <div className="flex -space-x-2">
                {accessMembers.slice(0, 8).map((u) => (
                  <div key={u.id} className="ring-2 ring-card rounded-full">
                    <AvatarCircle user={u} size={28} />
                  </div>
                ))}
              </div>
              {accessMembers.length > 8 && (
                <span className="text-xs text-muted-foreground">
                  +{accessMembers.length - 8} more
                </span>
              )}
              <Link
                to={`/projects/${projectId}/settings`}
                className="ml-3 text-xs text-muted-foreground hover:text-foreground"
              >
                Manage access →
              </Link>
            </div>
          )}
        </div>
      </header>

      <ProjectTabs projectId={projectId} />

      <main className="px-4 sm:px-6 md:px-10 py-6 sm:py-8 space-y-6 sm:space-y-8 max-w-6xl mx-auto w-full">
        {/* Stat tiles */}
        <section className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 sm:gap-3">
          <StatTile
            label="Open"
            value={stats.open}
            href={`/projects/${projectId}/board`}
            tone="neutral"
            icon={<LayoutDashboard className="h-3.5 w-3.5" />}
          />
          <StatTile
            label="In progress"
            value={stats.inProgress}
            href={`/projects/${projectId}/board`}
            tone="info"
            icon={<Sparkles className="h-3.5 w-3.5" />}
          />
          <StatTile
            label="Blocked"
            value={stats.blocked}
            href={`/projects/${projectId}/board?blocked=true`}
            tone={stats.blocked > 0 ? 'warning' : 'neutral'}
            icon={<Flame className="h-3.5 w-3.5" />}
          />
          <StatTile
            label="Overdue"
            value={stats.overdue}
            href={`/projects/${projectId}/board`}
            tone={stats.overdue > 0 ? 'danger' : 'neutral'}
            icon={<Timer className="h-3.5 w-3.5" />}
          />
          <StatTile
            label="Done"
            value={stats.done}
            href={`/projects/${projectId}/board`}
            tone="success"
            icon={<Target className="h-3.5 w-3.5" />}
          />
        </section>

        {/* Active sprint progress + Quick views */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Sprint card spans 2 cols if active sprint exists */}
          <div className={cn('lg:col-span-2', !activeSprint && 'lg:col-span-2')}>
            {activeSprint ? (
              <ActiveSprintCard sprint={activeSprint} tasks={topLevel} projectId={projectId} />
            ) : (
              <NoSprintCard projectId={projectId} sprintsEnabled={project.sprintsEnabled} />
            )}
          </div>
          <PriorityBreakdown tasks={topLevel} projectId={projectId} />
        </section>

        {/* Quick-link cards — every project sub-view, with subtle hover lift */}
        <section>
          <h2 className="nockta-eyebrow text-muted-foreground mb-3">Explore</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <QuickLink to={`/projects/${projectId}/board`} icon={<LayoutDashboard />} title="Board" subtitle="Kanban + List" />
            {/* Backlog covers sprints + backlog on a single page; no separate Sprints tile. */}
            <QuickLink
              to={`/projects/${projectId}/backlog`}
              icon={<Inbox />}
              title="Backlog"
              subtitle={project.sprintsEnabled ? 'Sprints + backlog' : 'Plan + drag'}
            />
            <QuickLink to={`/projects/${projectId}/timeline`} icon={<BarChart3 />} title="Timeline" subtitle="Gantt view" />
            <QuickLink to={`/projects/${projectId}/docs`} icon={<FileText />} title="Docs" subtitle="Wiki + specs" />
            <QuickLink to={`/projects/${projectId}/automations`} icon={<Zap />} title="Automations" subtitle="Rules + webhooks" />
            <QuickLink to={`/projects/${projectId}/settings`} icon={<Settings />} title="Settings" subtitle="Access + config" />
          </div>
        </section>

        {/* Recent activity */}
        <section>
          <header className="flex items-end justify-between mb-3">
            <h2 className="nockta-eyebrow text-muted-foreground">Recent activity</h2>
            <Link
              to={`/projects/${projectId}/board`}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Open board →
            </Link>
          </header>
          {recent.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing yet — kick something off on the board.</p>
          ) : (
            <ul className="rounded-xl border border-border bg-card/40 divide-y divide-border">
              {recent.map((e) => (
                <li key={e.id} className="px-4 py-2.5 text-xs flex items-center gap-3">
                  {e.actor ? <AvatarCircle user={e.actor} size={20} /> : <span className="h-5 w-5 rounded-full bg-secondary/60" />}
                  <span className="flex-1 min-w-0 truncate">
                    <span className="font-medium">{e.actor?.name ?? 'System'}</span>{' '}
                    <span className="text-muted-foreground">{humanizeEventType(e.type)}</span>{' '}
                    {typeof e.payload['title'] === 'string' && (
                      <span className="truncate">"{String(e.payload['title'])}"</span>
                    )}
                  </span>
                  <span className="text-[10px] text-muted-foreground/70 tabular-nums shrink-0">
                    {timeAgo(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

// =============================================================================
// Subcomponents
// =============================================================================

function StatTile({
  label,
  value,
  href,
  tone,
  icon,
}: {
  label: string;
  value: number;
  href: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  icon: React.ReactNode;
}): JSX.Element {
  return (
    <Link
      to={href}
      className={cn(
        'group relative overflow-hidden rounded-xl border bg-card/60 p-4 transition-all',
        'hover:border-primary/40 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20',
        tone === 'danger' && 'border-priority-high/30',
        tone === 'warning' && 'border-priority-medium/30',
        tone === 'success' && 'border-status-done/30',
        tone === 'info' && 'border-brand/30',
        tone === 'neutral' && 'border-border',
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span className={cn(
          'inline-flex items-center gap-1 text-[10px] uppercase tracking-wider',
          tone === 'danger' && 'text-priority-high',
          tone === 'warning' && 'text-priority-medium',
          tone === 'success' && 'text-status-done',
          tone === 'info' && 'text-brand',
          tone === 'neutral' && 'text-muted-foreground',
        )}>
          {icon}
          {label}
        </span>
        <ArrowUpRight className="h-3 w-3 text-muted-foreground/40 group-hover:text-foreground transition-colors" />
      </div>
      <p className="text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
    </Link>
  );
}

function ActiveSprintCard({
  sprint,
  tasks,
  projectId,
}: {
  sprint: SprintRow;
  tasks: Task[];
  projectId: string;
}): JSX.Element {
  // The sprint object from the list endpoint doesn't include the tasks; use
  // the task list and filter by status to approximate progress. A future
  // refinement is to use the burndown endpoint for an exact remaining-estimate
  // chart, but this is the right tile-level summary for now.
  const inSprint = tasks.filter((t) => /done|approved/i.test(t.status));
  const done = inSprint.length;
  const total = sprint._count?.tasks ?? tasks.length;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <Link
      to={`/projects/${projectId}/sprints/${sprint.id}/plan`}
      className="block rounded-xl border border-brand/30 bg-card/60 p-5 transition-all hover:border-brand/50 hover:shadow-lg"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-brand">
          <span className="h-1.5 w-1.5 rounded-full bg-brand animate-pulse" />
          Active sprint
        </span>
        {(sprint.startDate || sprint.endDate) && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {sprint.startDate ? new Date(sprint.startDate).toLocaleDateString() : '—'}
            {' → '}
            {sprint.endDate ? new Date(sprint.endDate).toLocaleDateString() : '—'}
          </span>
        )}
      </div>
      <p className="text-lg font-semibold tracking-tight">{sprint.name}</p>
      <div className="mt-4">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1.5 tabular-nums">
          <span>{done} of {total} done</span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 rounded-full bg-secondary/40 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-brand to-brand/60 transition-[width] duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </Link>
  );
}

function NoSprintCard({
  projectId,
  sprintsEnabled,
}: {
  projectId: string;
  sprintsEnabled: boolean;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/30 p-5">
      <p className="nockta-eyebrow text-muted-foreground">Sprint</p>
      <p className="mt-2 text-sm">
        {sprintsEnabled
          ? 'No active sprint right now. Plan one to kick off the next push.'
          : 'Sprints are off for this project. Enable to plan in two-week cycles.'}
      </p>
      <Link
        to={`/projects/${projectId}/backlog`}
        className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition"
      >
        {sprintsEnabled ? 'Plan a sprint' : 'Open backlog'}
        <ArrowUpRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

function PriorityBreakdown({ tasks, projectId }: { tasks: Task[]; projectId: string }): JSX.Element {
  const open = tasks.filter((t) => !/done|approved/i.test(t.status));
  const counts = {
    Critical: open.filter((t) => t.priority === 'Critical').length,
    High: open.filter((t) => t.priority === 'High').length,
    Medium: open.filter((t) => t.priority === 'Medium').length,
    Low: open.filter((t) => t.priority === 'Low').length,
  };
  const total = open.length || 1;
  const segments: { key: keyof typeof counts; color: string }[] = [
    { key: 'Critical', color: 'bg-priority-critical' },
    { key: 'High', color: 'bg-priority-high' },
    { key: 'Medium', color: 'bg-priority-medium' },
    { key: 'Low', color: 'bg-priority-low' },
  ];
  return (
    <Link
      to={`/projects/${projectId}/board`}
      className="block rounded-xl border border-border bg-card/40 p-5 hover:border-primary/40 transition-colors"
    >
      <p className="nockta-eyebrow text-muted-foreground">Open by priority</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{open.length}</p>
      <div className="mt-4 h-3 rounded-full bg-secondary/40 overflow-hidden flex">
        {segments.map((s) => {
          const c = counts[s.key];
          if (c === 0) return null;
          return (
            <div
              key={s.key}
              className={s.color}
              style={{ width: `${(c / total) * 100}%` }}
              title={`${s.key}: ${c}`}
            />
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-y-1 text-[11px] text-muted-foreground">
        {segments.map((s) =>
          counts[s.key] > 0 ? (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 rounded-full', s.color)} />
              {s.key}
              <span className="ml-auto tabular-nums">{counts[s.key]}</span>
            </span>
          ) : null,
        )}
      </div>
    </Link>
  );
}

function QuickLink({
  to,
  icon,
  title,
  subtitle,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className={cn(
        'group relative overflow-hidden rounded-xl border border-border bg-card/40 p-4 transition-all',
        'hover:border-primary/40 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-secondary/60 text-muted-foreground group-hover:text-primary group-hover:bg-primary/10 transition-colors [&_svg]:h-4 [&_svg]:w-4">
          {icon}
        </span>
        <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-foreground transition-colors" />
      </div>
      <p className="mt-3 text-sm font-semibold">{title}</p>
      <p className="text-[10px] text-muted-foreground">{subtitle}</p>
    </Link>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function humanizeEventType(t: string): string {
  return t
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toLowerCase())
    .replace(/_/g, ' ')
    .trim();
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
