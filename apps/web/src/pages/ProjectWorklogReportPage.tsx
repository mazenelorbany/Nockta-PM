import { useQuery } from '@tanstack/react-query';
import { Download, Timer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn, EmptyState, QueryErrorState, SkeletonList } from '@nockta/ui';

import { ProjectTabs } from '../components/ProjectTabs';
import { AvatarCircle } from '../components/task-bits';
import { api } from '../lib/api';
import { useResolvedProject } from '../lib/project-route';
import { queryKeys } from '../lib/query-keys';

// =============================================================================
// /projects/:projectId/worklog
//
// Per-project worklog matrix: rows are teammates who logged time on this
// project, columns are the last N ISO weeks (Monday-start, UTC), cells show
// hours logged with one decimal of precision. Row totals + CSV export.
//
// Members with zero hours across the window are dropped server-side so the
// table doesn't carry empty rows. Rows are already sorted by total descending.
// =============================================================================

interface ReportRow {
  user: { id: string; name: string; email: string; avatarUrl: string | null };
  cells: number[]; // seconds, parallel to weekStartsUTC
  totalSeconds: number;
}

interface ReportResp {
  weekStartsUTC: string[];
  rows: ReportRow[];
}

interface Project {
  id: string;
  key: string;
  name: string;
}

const WEEK_OPTIONS = [4, 8, 12, 26] as const;

export function ProjectWorklogReportPage(): JSX.Element {
  const { projectId } = useResolvedProject();
  const [weeks, setWeeks] = useState<number>(12);

  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const reportQuery = useQuery({
    queryKey: ['project', projectId, 'worklog-report', weeks],
    queryFn: () =>
      api.get<ReportResp>(`/analytics/projects/${projectId}/worklog-report?weeks=${weeks}`),
    enabled: Boolean(projectId),
  });

  const project = projectQuery.data;
  const data = reportQuery.data;

  const grandTotal = useMemo(() => {
    if (!data) return 0;
    return data.rows.reduce((acc, r) => acc + r.totalSeconds, 0);
  }, [data]);

  function exportCsv(): void {
    if (!data) return;
    const header = ['Name', 'Email', ...data.weekStartsUTC, 'Total (hours)'];
    const escape = (v: string): string => {
      if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
      return v;
    };
    const lines: string[] = [header.map(escape).join(',')];
    for (const r of data.rows) {
      const cells = r.cells.map((s) => (s / 3600).toFixed(2));
      lines.push(
        [r.user.name, r.user.email, ...cells, (r.totalSeconds / 3600).toFixed(2)]
          .map((v) => escape(String(v)))
          .join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project?.key ?? 'project'}-worklog-${weeks}w.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

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
          <span className="text-sm text-muted-foreground hidden sm:inline">Worklog report</span>
        </div>
      </header>

      <ProjectTabs projectId={projectId} />

      <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <span className="nockta-eyebrow text-muted-foreground">Window</span>
        <div className="flex items-center gap-1">
          {WEEK_OPTIONS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWeeks(w)}
              className={cn(
                'inline-flex items-center px-2.5 h-7 rounded-md text-xs transition-colors',
                weeks === w
                  ? 'bg-accent text-foreground border border-brand/40'
                  : 'border border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
              )}
            >
              {w} weeks
            </button>
          ))}
        </div>
        <span className="ml-auto nockta-eyebrow text-muted-foreground tabular-nums">
          {(grandTotal / 3600).toFixed(1)} h total
        </span>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!data || data.rows.length === 0}
          className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs border border-border bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 sm:p-6 md:p-8">
        {reportQuery.isLoading ? (
          <SkeletonList rows={6} rowClassName="h-10" />
        ) : reportQuery.isError ? (
          <QueryErrorState
            title="Couldn't load worklog report"
            error={reportQuery.error}
            onRetry={() => void reportQuery.refetch()}
          />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={<Timer className="h-5 w-5" />}
            title="No time logged in this window"
            description="Nobody on this project has logged time in the selected weeks. Try a wider window or check that worklog entries exist."
          />
        ) : (
          // Worklog table has one column per ISO week + a sticky Member column
          // and a Total column. Even 4 weeks is wider than a phone viewport,
          // so this table genuinely needs horizontal scroll. Audit exception.
          <div className="overflow-x-auto rounded-lg border border-border bg-card/40">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/30">
                  <th className="text-left font-medium px-3 py-2 sticky left-0 bg-secondary/30 z-10">
                    Member
                  </th>
                  {data.weekStartsUTC.map((iso) => (
                    <th
                      key={iso}
                      className="text-right font-medium px-2 py-2 tabular-nums whitespace-nowrap text-muted-foreground"
                      title={iso}
                    >
                      {formatWeekHeader(iso)}
                    </th>
                  ))}
                  <th className="text-right font-semibold px-3 py-2 tabular-nums whitespace-nowrap">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.user.id} className="border-b border-border/60 last:border-b-0">
                    <td className="px-3 py-2 sticky left-0 bg-card z-10">
                      <div className="flex items-center gap-2 min-w-[180px]">
                        <AvatarCircle user={r.user} size={24} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{r.user.name}</p>
                          <p className="text-[10px] text-muted-foreground truncate">
                            {r.user.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    {r.cells.map((seconds, i) => (
                      <td
                        key={i}
                        className={cn(
                          'text-right px-2 py-2 tabular-nums whitespace-nowrap',
                          seconds === 0 && 'text-muted-foreground/40',
                        )}
                      >
                        {seconds === 0 ? '—' : (seconds / 3600).toFixed(1)}
                      </td>
                    ))}
                    <td className="text-right px-3 py-2 tabular-nums font-semibold whitespace-nowrap">
                      {(r.totalSeconds / 3600).toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Render a week-start as a compact "MMM D" string. */
function formatWeekHeader(iso: string): string {
  // Parse as UTC midnight so we don't drift across local timezones.
  const d = new Date(`${iso}T00:00:00Z`);
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${month} ${d.getUTCDate()}`;
}
