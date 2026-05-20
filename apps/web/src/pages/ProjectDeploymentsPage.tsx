import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Rocket } from 'lucide-react';
import { cn, EmptyState, QueryErrorState, SkeletonList } from '@nockta/ui';

import { ProjectTabs } from '../components/ProjectTabs';
import { api } from '../lib/api';
import { useResolvedProject } from '../lib/project-route';
import { queryKeys } from '../lib/query-keys';

// =============================================================================
// /projects/:projectId/deployments
//
// Last 30 deployments to this project. Shows: status pill, environment chip,
// source chip, short sha, relative time, count of linked tasks.
//
// NOTE: the Deployment row has no `deployedBy` user reference — that info only
// exists inside `rawPayload` and isn't normalized today. The visual spec
// called for "deployer avatar+name" but we render the commit message preview
// instead, which is the most useful field actually available.
// =============================================================================

type DeploymentStatus = 'started' | 'succeeded' | 'failed' | 'rolled_back';
type DeploymentSource = 'vercel' | 'railway' | 'github_actions' | 'manual';

interface DeploymentRow {
  id: string;
  source: DeploymentSource;
  status: DeploymentStatus;
  environment: string;
  commitSha: string | null;
  commitMessage: string | null;
  url: string | null;
  startedAt: string;
  finishedAt: string | null;
  taskCount: number;
}

interface Project {
  id: string;
  key: string;
  name: string;
}

export function ProjectDeploymentsPage(): JSX.Element {
  const { projectId } = useResolvedProject();

  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const deploysQuery = useQuery({
    queryKey: ['project', projectId, 'deployments'],
    queryFn: () => api.get<DeploymentRow[]>(`/projects/${projectId}/deployments?limit=30`),
    enabled: Boolean(projectId),
  });

  const project = projectQuery.data;
  const rows = deploysQuery.data ?? [];

  if (!project) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-3 sm:py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">
            {project.key}
          </span>
          <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate">
            {project.name}
          </h1>
          <span className="text-muted-foreground/60 hidden sm:inline">·</span>
          <span className="text-sm text-muted-foreground hidden sm:inline">Deployments</span>
        </div>
      </header>

      <ProjectTabs projectId={projectId} />

      <div className="flex-1 overflow-auto p-4 sm:p-6 md:p-8">
        {deploysQuery.isLoading ? (
          <SkeletonList rows={6} rowClassName="h-12" />
        ) : deploysQuery.isError ? (
          <QueryErrorState
            title="Couldn't load deployments"
            error={deploysQuery.error}
            onRetry={() => void deploysQuery.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Rocket className="h-5 w-5" />}
            title="No deployments yet"
            description="When this project's CI/CD pipeline fires a webhook, the deploys will show up here. Configure a webhook secret in Project Settings."
          />
        ) : (
          <>
            {/* Mobile: stack each deploy as a card so columns reflow vertically
                instead of forcing horizontal scroll. The desktop table below
                is hidden <md. */}
            <ul className="md:hidden space-y-2">
              {rows.map((d) => (
                <li
                  key={d.id}
                  className="rounded-lg border border-border bg-card/40 p-3 space-y-2"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusPill status={d.status} />
                    <EnvChip env={d.environment} />
                    <SourceChip source={d.source} />
                    <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                      {formatRelative(d.startedAt)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    {d.commitSha && (
                      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                        {d.commitSha.slice(-7)}
                      </span>
                    )}
                    {d.commitMessage && (
                      <span className="text-xs leading-snug" title={d.commitMessage}>
                        {d.commitMessage.split('\n')[0]}
                      </span>
                    )}
                    {!d.commitSha && !d.commitMessage && (
                      <span className="text-xs text-muted-foreground/60">—</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {d.taskCount > 0 ? (
                        <>
                          <span className="font-medium tabular-nums">{d.taskCount}</span>{' '}
                          {d.taskCount === 1 ? 'task' : 'tasks'}
                        </>
                      ) : (
                        <span className="text-muted-foreground/40">No linked tasks</span>
                      )}
                    </span>
                    {d.url && (
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                        title="Open deployment"
                      >
                        Open
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {/* Desktop: standard table. No overflow-x needed at >=md — every
                column fits the available width. */}
            <div className="hidden md:block rounded-lg border border-border bg-card/40">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/30 text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">Status</th>
                    <th className="text-left font-medium px-3 py-2">Environment</th>
                    <th className="text-left font-medium px-3 py-2">Source</th>
                    <th className="text-left font-medium px-3 py-2">Commit</th>
                    <th className="text-left font-medium px-3 py-2">Started</th>
                    <th className="text-right font-medium px-3 py-2">Tasks</th>
                    <th className="text-right font-medium px-3 py-2 w-8" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id} className="border-b border-border/60 last:border-b-0 hover:bg-accent/30">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <StatusPill status={d.status} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <EnvChip env={d.environment} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <SourceChip source={d.source} />
                      </td>
                      <td className="px-3 py-2 min-w-[200px]">
                        <div className="flex flex-col gap-0.5 min-w-0">
                          {d.commitSha && (
                            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                              {d.commitSha.slice(-7)}
                            </span>
                          )}
                          {d.commitMessage && (
                            <span className="text-xs truncate max-w-[280px]" title={d.commitMessage}>
                              {d.commitMessage.split('\n')[0]}
                            </span>
                          )}
                          {!d.commitSha && !d.commitMessage && (
                            <span className="text-xs text-muted-foreground/60">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                        {formatRelative(d.startedAt)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-right tabular-nums text-xs">
                        {d.taskCount > 0 ? (
                          <span className="font-medium">{d.taskCount}</span>
                        ) : (
                          <span className="text-muted-foreground/40">0</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-right">
                        {d.url && (
                          <a
                            href={d.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                            title="Open deployment"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: DeploymentStatus }): JSX.Element {
  const cfg: Record<DeploymentStatus, { label: string; cls: string }> = {
    succeeded: { label: 'Succeeded', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
    failed: { label: 'Failed', cls: 'bg-rose-500/15 text-rose-400 border-rose-500/30' },
    started: { label: 'Running', cls: 'bg-sky-500/15 text-sky-400 border-sky-500/30' },
    rolled_back: { label: 'Rolled back', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  };
  const c = cfg[status];
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 h-5 rounded text-[11px] font-medium border',
        c.cls,
      )}
    >
      {c.label}
    </span>
  );
}

function EnvChip({ env }: { env: string }): JSX.Element {
  const isProd = /prod/i.test(env);
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 h-5 rounded text-[11px] font-mono border',
        isProd
          ? 'bg-brand/10 text-brand border-brand/30'
          : 'bg-secondary/40 text-muted-foreground border-border',
      )}
    >
      {env}
    </span>
  );
}

function SourceChip({ source }: { source: DeploymentSource }): JSX.Element {
  const labels: Record<DeploymentSource, string> = {
    vercel: 'Vercel',
    railway: 'Railway',
    github_actions: 'GitHub Actions',
    manual: 'Manual',
  };
  return (
    <span className="inline-flex items-center px-1.5 h-5 rounded text-[11px] font-medium bg-secondary/60 text-foreground/80 border border-border">
      {labels[source] ?? source}
    </span>
  );
}

/** Compact relative time: "5m ago", "3h ago", "2d ago", else date. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
