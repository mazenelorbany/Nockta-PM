import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { cn, NocktaMark, QueryErrorState, Skeleton } from '@nockta/ui';

import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import { queryKeys } from '../lib/query-keys';

// Reports tab is rarely-used + brings its own form/editor surface — keep it
// off the analytics initial chunk. The tab strip already shows a skeleton
// while the chunk streams in.
const AnalyticsReportsPage = lazy(() =>
  import('./AnalyticsReportsPage').then((m) => ({ default: m.AnalyticsReportsPage })),
);

// =============================================================================
// /analytics — recharts-powered dashboards for personal + org.
// =============================================================================

interface PersonalData {
  openByPriority: { priority: 'Low' | 'Medium' | 'High' | 'Critical'; count: number }[];
  overdueCount: number;
  watchingCount: number;
  mentionsLast7Days: number;
}

interface OrgData {
  totalOpen: number;
  byProject: { projectId: string; projectKey: string; projectName: string; open: number; done: number }[];
  blockedCount: number;
  overdueCount: number;
}

interface BurndownData {
  sprintId: string;
  sprintName: string;
  points: { date: string; remaining: number; ideal: number }[];
}

interface Project {
  id: string;
  key: string;
  name: string;
}

interface Sprint {
  id: string;
  name: string;
  state: 'planned' | 'active' | 'completed';
}

/**
 * Velocity payload returned by GET /analytics/projects/:id/velocity. The
 * sprintVelocity helper now emits both `planned*` and `completed*` figures
 * so the cross-sprint comparison chart can show planned-vs-completed bars
 * over time alongside a trend line.
 */
interface VelocityData {
  sprints: {
    sprintId: string;
    name: string;
    endDate: string | null;
    plannedCount: number;
    plannedEstimate: number;
    completedCount: number;
    completedEstimate: number;
  }[];
  averageCount: number;
  averageEstimate: number;
  projectedNext: { count: number; estimate: number } | null;
}

export function AnalyticsPage(): JSX.Element {
  const { user } = useAuth();
  const isAdmin = user?.companyRole === 'Admin';
  const [tab, setTab] = useState<'personal' | 'org' | 'burndown' | 'velocity' | 'reports'>('personal');

  return (
    <div className="flex flex-col h-full">
      <header className="relative overflow-hidden border-b border-border gradient-mesh-subtle">
        <div
          className="absolute -right-12 -bottom-16 text-brand/[0.05] pointer-events-none select-none"
          aria-hidden="true"
        >
          <NocktaMark className="h-[240px] w-[240px]" />
        </div>
        <div className="relative px-4 sm:px-6 md:px-8 pt-6 sm:pt-8 pb-6 sm:pb-8">
          <span className="nockta-eyebrow text-brand">{'Insights'}</span>
          <h1
            className="display-heading mt-2 leading-[1.04]"
            style={{ fontSize: 'clamp(1.8rem, 3.4vw, 2.6rem)' }}
          >
            {'Analytics'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground max-w-xl">
            {'Throughput, cycle time, and burndown across your work and the org.'}
          </p>
        </div>
      </header>
      {/* Tab strip — small pills, allowed to overflow horizontally on narrow
          phones rather than wrap to a second row. Audit exception. */}
      <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-1 overflow-x-auto">
        {(
          [
            { id: 'personal' as const, label: 'My work' },
            ...(isAdmin ? [{ id: 'org' as const, label: 'Organization' }] : []),
            { id: 'burndown' as const, label: 'Sprint burndown' },
            { id: 'velocity' as const, label: 'Velocity' },
            { id: 'reports' as const, label: 'Reports' },
          ]
        ).map((tab2) => (
          <button
            key={tab2.id}
            type="button"
            onClick={() => setTab(tab2.id)}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              tab === tab2.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            {tab2.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-4 sm:p-6 md:p-8">
        {tab === 'personal' && <PersonalDashboard />}
        {tab === 'org' && isAdmin && <OrgDashboard />}
        {tab === 'burndown' && <BurndownTab />}
        {tab === 'velocity' && <VelocityTab />}
        {tab === 'reports' && (
          <Suspense fallback={<Skeleton className="h-64" />}>
            <AnalyticsReportsPage />
          </Suspense>
        )}
      </div>
    </div>
  );
}

// =============================================================================

function PersonalDashboard(): JSX.Element {
  const personalQuery = useQuery({
    queryKey: ['analytics', 'me'],
    queryFn: () => api.get<PersonalData>('/analytics/me'),
  });

  if (personalQuery.isError) {
    return (
      <QueryErrorState
        title="Couldn't load your analytics"
        error={personalQuery.error}
        onRetry={() => void personalQuery.refetch()}
      />
    );
  }
  if (personalQuery.isLoading || !personalQuery.data) {
    return <AnalyticsLoading />;
  }

  const d = personalQuery.data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="Overdue tasks" value={d.overdueCount} tone="destructive" />
        <StatCard label="Watching" value={d.watchingCount} />
        <StatCard label="@Mentions (7d)" value={d.mentionsLast7Days} />
      </div>

      <ChartCard title="Open tasks by priority">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={d.openByPriority}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="priority" stroke="hsl(var(--muted-foreground))" fontSize={11} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'hsl(var(--accent) / 0.4)' }} />
            <Bar dataKey="count" radius={[6, 6, 0, 0]}>
              {d.openByPriority.map((p) => (
                <rect key={p.priority} fill={priorityColor(p.priority)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

function OrgDashboard(): JSX.Element {
  const orgQuery = useQuery({
    queryKey: ['analytics', 'org'],
    queryFn: () => api.get<OrgData>('/analytics/org'),
  });
  if (orgQuery.isError) {
    return (
      <QueryErrorState
        title="Couldn't load org analytics"
        error={orgQuery.error}
        onRetry={() => void orgQuery.refetch()}
      />
    );
  }
  if (orgQuery.isLoading || !orgQuery.data) {
    return <AnalyticsLoading />;
  }
  const d = orgQuery.data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="Open tasks" value={d.totalOpen} />
        <StatCard label="Blocked" value={d.blockedCount} tone="destructive" />
        <StatCard label="Overdue" value={d.overdueCount} tone="warning" />
      </div>
      <ChartCard title="Open vs. done by project">
        <ResponsiveContainer width="100%" height={Math.max(260, d.byProject.length * 32)}>
          <BarChart data={d.byProject} layout="vertical" margin={{ left: 80 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={11} />
            <YAxis
              dataKey="projectKey"
              type="category"
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              width={70}
            />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'hsl(var(--accent) / 0.4)' }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="open" stackId="a" fill="hsl(var(--brand))" radius={[0, 4, 4, 0]} />
            <Bar dataKey="done" stackId="a" fill="hsl(var(--status-done))" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

function BurndownTab(): JSX.Element {
  const [projectId, setProjectId] = useState<string>('');
  const [sprintId, setSprintId] = useState<string>('');

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<Project[]>('/projects'),
  });
  const sprintsQuery = useQuery({
    queryKey: queryKeys.sprints(projectId),
    queryFn: () => api.get<Sprint[]>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId),
  });
  const burndownQuery = useQuery({
    queryKey: ['burndown', sprintId],
    queryFn: () => api.get<BurndownData>(`/analytics/sprints/${sprintId}/burndown`),
    enabled: Boolean(sprintId),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <select
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setSprintId('');
          }}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">Pick a project…</option>
          {(projectsQuery.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.key} · {p.name}</option>
          ))}
        </select>
        {projectId && (
          <select
            value={sprintId}
            onChange={(e) => setSprintId(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Pick a sprint…</option>
            {(sprintsQuery.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {s.state}</option>
            ))}
          </select>
        )}
      </div>

      {sprintId && burndownQuery.data ? (
        <ChartCard title={`Burndown · ${burndownQuery.data.sprintName}`}>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={burndownQuery.data.points}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="ideal" stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" dot={false} />
              <Line type="monotone" dataKey="remaining" stroke="hsl(var(--brand))" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card/30 p-8 text-sm text-muted-foreground text-center">
          Pick a project and sprint to see the burndown chart.
        </div>
      )}
    </div>
  );
}

// =============================================================================
// VelocityTab — Cross-sprint velocity comparison. Per project, the last N
// completed sprints are plotted as paired planned-vs-completed bars with a
// trend line over completed points. Drawn with recharts ComposedChart so the
// two visual encodings (bars + line) overlay cleanly.
// =============================================================================

function VelocityTab(): JSX.Element {
  const [projectId, setProjectId] = useState<string>('');
  /// Toggle between counts (tasks) and estimate (points). Stored on the
  /// component because each project picks a different convention; remembering
  /// across mount/unmount via URL/localStorage isn't justified yet.
  const [metric, setMetric] = useState<'count' | 'estimate'>('count');

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<Project[]>('/projects'),
  });
  const velocityQuery = useQuery({
    queryKey: ['velocity', projectId],
    queryFn: () => api.get<VelocityData>(`/analytics/projects/${projectId}/velocity`),
    enabled: Boolean(projectId),
  });

  const v = velocityQuery.data;
  const rows = v?.sprints ?? [];
  const points = rows.map((s) => ({
    name: s.name,
    planned: metric === 'count' ? s.plannedCount : s.plannedEstimate,
    completed: metric === 'count' ? s.completedCount : s.completedEstimate,
  }));
  const average = metric === 'count' ? v?.averageCount ?? 0 : v?.averageEstimate ?? 0;

  // Pass I (Sprints 8→9). Goal hit-rate companion line on the velocity tab.
  // Reads /analytics/projects/:id/goal-hit-rate. Hidden until at least one
  // completed sprint has a SprintGoalEvaluation row — otherwise the rate is
  // null and the chip would be misleading.
  const goalHitRateQuery = useQuery<{
    totalSprints: number;
    totalEvaluated: number;
    goalsAchieved: number;
    rate: number | null;
  }>({
    queryKey: ['goal-hit-rate', projectId],
    queryFn: () => api.get(`/analytics/projects/${projectId}/goal-hit-rate`),
    enabled: Boolean(projectId),
  });
  const hitRate = goalHitRateQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">Pick a project…</option>
          {(projectsQuery.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.key} · {p.name}</option>
          ))}
        </select>
        <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setMetric('count')}
            className={cn(
              'px-3 py-1.5 transition-colors',
              metric === 'count' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/40',
            )}
          >
            Tasks
          </button>
          <button
            type="button"
            onClick={() => setMetric('estimate')}
            className={cn(
              'px-3 py-1.5 transition-colors border-l border-border',
              metric === 'estimate' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/40',
            )}
          >
            Points
          </button>
        </div>
        {v && rows.length > 0 && (
          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              Avg <strong className="text-foreground tabular-nums">{average}</strong>
            </span>
            {v.projectedNext && (
              <span>
                Next sprint projection{' '}
                <strong className="text-foreground tabular-nums">
                  {metric === 'count' ? v.projectedNext.count : v.projectedNext.estimate}
                </strong>
              </span>
            )}
            {/* Pass I (Sprints 8→9). Goal hit-rate chip. */}
            {hitRate && hitRate.totalEvaluated > 0 && (
              <span>
                Goal hit rate{' '}
                <strong className="text-foreground tabular-nums">
                  {Math.round((hitRate.rate ?? 0) * 100)}%
                </strong>{' '}
                ({hitRate.goalsAchieved}/{hitRate.totalEvaluated})
              </span>
            )}
          </div>
        )}
      </div>

      {!projectId ? (
        <div className="rounded-lg border border-dashed border-border bg-card/30 p-8 text-sm text-muted-foreground text-center">
          Pick a project to compare sprint velocity.
        </div>
      ) : velocityQuery.isLoading ? (
        <Skeleton className="h-80 w-full" />
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card/30 p-8 text-sm text-muted-foreground text-center">
          No completed sprints yet. Once a sprint finishes, its planned vs
          completed totals will appear here.
        </div>
      ) : (
        <ChartCard title="Planned vs completed by sprint">
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={points} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
              <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="planned" name="Planned" fill="hsl(var(--muted-foreground))" radius={[4, 4, 0, 0]} barSize={26} />
              <Bar dataKey="completed" name="Completed" fill="hsl(var(--brand))" radius={[4, 4, 0, 0]} barSize={26} />
              <Line
                type="monotone"
                dataKey="completed"
                name="Trend"
                stroke="hsl(var(--brand))"
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}

// =============================================================================

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'destructive' | 'warning';
}): JSX.Element {
  const accent =
    tone === 'destructive' ? 'text-status-blocked' :
    tone === 'warning' ? 'text-priority-high' :
    'text-brand';
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="nockta-eyebrow text-muted-foreground">{label}</div>
      <div className={cn('text-3xl font-bold tracking-tight mt-1', accent)}>{value}</div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-sm font-semibold mb-4">{title}</h3>
      {children}
    </div>
  );
}

function priorityColor(p: 'Low' | 'Medium' | 'High' | 'Critical'): string {
  if (p === 'Critical') return 'hsl(var(--priority-critical))';
  if (p === 'High')     return 'hsl(var(--priority-high))';
  if (p === 'Medium')   return 'hsl(var(--priority-medium))';
  return 'hsl(var(--priority-low))';
}

const tooltipStyle: React.CSSProperties = {
  backgroundColor: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 12,
};

function AnalyticsLoading(): JSX.Element {
  // Same shape as the real layout so the page doesn't reflow when data lands:
  // three stat tiles on top, a tall chart card underneath.
  return (
    <div className="space-y-6" role="status" aria-label="Loading analytics">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}
