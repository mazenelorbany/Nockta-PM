import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, Users } from 'lucide-react';
import { cn, EmptyState, QueryErrorState, SkeletonList } from '@nockta/ui';

import { api } from '../../lib/api';
import { AvatarCircle } from '../../components/task-bits';

// =============================================================================
// HoursByUserTab — workspace-wide "hours per user" report. Backed by
// GET /analytics/worklog/by-user?from=&to=&projectId? (Admin-only).
//
// Sits as a tab on /analytics. The user wanted a single, polished surface that
// answers "how many hours did each teammate spend this month, regardless of
// which task" — so the page leads with date-range presets (this month is the
// default), shows a workspace summary row, then a sortable per-user table
// with expandable per-project breakdowns and a CSV download.
//
// All times in seconds at the API; we format hours client-side for display.
// The optional project filter is workspace-wide too — pass it through as a
// URL query param so callers can deep-link to a specific scope.
// =============================================================================

interface ProjectOption {
  id: string;
  key: string;
  name: string;
}

interface ByProject {
  projectId: string;
  key: string;
  name: string;
  seconds: number;
}

interface ByDay {
  date: string;
  seconds: number;
}

interface UserRow {
  user: { id: string; name: string; email: string; avatarUrl: string | null; kind: 'internal' | 'client' };
  totalSeconds: number;
  entryCount: number;
  byProject: ByProject[];
  byDay: ByDay[];
}

interface Report {
  range: { from: string; to: string };
  filters: { projectId: string | null };
  totals: { totalSeconds: number; distinctUsers: number; entryCount: number };
  users: UserRow[];
}

type Preset = 'this-month' | 'last-month' | 'last-30-days' | 'this-quarter' | 'custom';

interface RangeState {
  preset: Preset;
  /** Day component only (yyyy-mm-dd) — picker output. We translate to ISO with TZ at fetch time. */
  fromDay: string;
  /** Inclusive on the picker; converted to an exclusive next-day boundary at fetch time. */
  toDay: string;
}

function computePresetRange(preset: Exclude<Preset, 'custom'>, now = new Date()): { fromDay: string; toDay: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (preset === 'this-month') {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    return { fromDay: toYmd(start), toDay: toYmd(today) };
  }
  if (preset === 'last-month') {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    return { fromDay: toYmd(start), toDay: toYmd(end) };
  }
  if (preset === 'last-30-days') {
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 29);
    return { fromDay: toYmd(start), toDay: toYmd(today) };
  }
  // this-quarter
  const q = Math.floor(today.getUTCMonth() / 3);
  const start = new Date(Date.UTC(today.getUTCFullYear(), q * 3, 1));
  return { fromDay: toYmd(start), toDay: toYmd(today) };
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function ymdToBoundaries(fromDay: string, toDay: string): { fromISO: string; toISO: string } {
  // Inclusive lower bound, EXCLUSIVE upper bound: shift `to` by +1 day at
  // 00:00 UTC so a range like 04-01..04-30 captures everything logged on
  // the 30th. Matches the API contract documented in worklog-by-user.ts.
  const from = new Date(`${fromDay}T00:00:00.000Z`);
  const to = new Date(`${toDay}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  return { fromISO: from.toISOString(), toISO: to.toISOString() };
}

export function HoursByUserTab(): JSX.Element {
  const [range, setRange] = useState<RangeState>(() => {
    const r = computePresetRange('this-month');
    return { preset: 'this-month', fromDay: r.fromDay, toDay: r.toDay };
  });
  const [projectId, setProjectId] = useState<string>('');
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  const projectsQuery = useQuery({
    queryKey: ['analytics', 'worklog-by-user', 'projects'],
    queryFn: () => api.get<ProjectOption[]>('/projects'),
  });

  const { fromISO, toISO } = useMemo(() => ymdToBoundaries(range.fromDay, range.toDay), [range.fromDay, range.toDay]);

  const reportQuery = useQuery<Report>({
    queryKey: ['analytics', 'worklog-by-user', fromISO, toISO, projectId || null],
    queryFn: () => {
      const qs = new URLSearchParams({ from: fromISO, to: toISO });
      if (projectId) qs.set('projectId', projectId);
      return api.get<Report>(`/analytics/worklog/by-user?${qs.toString()}`);
    },
  });

  function applyPreset(p: Exclude<Preset, 'custom'>): void {
    const r = computePresetRange(p);
    setRange({ preset: p, fromDay: r.fromDay, toDay: r.toDay });
  }

  function downloadCsv(): void {
    const r = reportQuery.data;
    if (!r) return;
    // Two-section CSV: a per-user totals header and a per-(user,project)
    // breakdown. Putting them together in one file keeps the export
    // single-click for non-technical operators while still giving the
    // detail downstream tooling needs.
    const lines: string[] = [];
    lines.push('Workspace hours-by-user report');
    lines.push(`Range,${r.range.from} → ${r.range.to}`);
    lines.push(`Total hours,${formatHours(r.totals.totalSeconds)}`);
    lines.push(`Distinct users,${r.totals.distinctUsers}`);
    lines.push('');
    lines.push('User,Email,Hours,Sessions');
    for (const row of r.users) {
      lines.push(`${csvCell(row.user.name)},${csvCell(row.user.email)},${formatHours(row.totalSeconds)},${row.entryCount}`);
    }
    lines.push('');
    lines.push('User,Email,Project,Hours');
    for (const row of r.users) {
      for (const p of row.byProject) {
        lines.push(`${csvCell(row.user.name)},${csvCell(row.user.email)},${csvCell(`${p.key} ${p.name}`)},${formatHours(p.seconds)}`);
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hours-by-user_${range.fromDay}_${range.toDay}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const projects = projectsQuery.data ?? [];

  return (
    <div className="space-y-5">
      {/* Controls — date presets + custom range + project filter + CSV button */}
      <div className="rounded-lg border border-border bg-card p-3 sm:p-4 flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="inline-flex rounded-md border border-border bg-background/60 p-0.5">
          {(
            [
              { id: 'this-month' as const, label: 'This month' },
              { id: 'last-month' as const, label: 'Last month' },
              { id: 'last-30-days' as const, label: 'Last 30 days' },
              { id: 'this-quarter' as const, label: 'This quarter' },
            ]
          ).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.id)}
              className={cn(
                'px-2.5 py-1 rounded text-[11px] font-medium transition-colors',
                range.preset === p.id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-[11px] text-muted-foreground">From</label>
          <input
            type="date"
            value={range.fromDay}
            onChange={(e) => setRange((r) => ({ ...r, preset: 'custom', fromDay: e.target.value }))}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          />
          <label className="text-[11px] text-muted-foreground">To</label>
          <input
            type="date"
            value={range.toDay}
            onChange={(e) => setRange((r) => ({ ...r, preset: 'custom', toDay: e.target.value }))}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          />
        </div>

        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          aria-label="Filter by project"
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.key} · {p.name}
            </option>
          ))}
        </select>

        <div className="flex-1" />

        <button
          type="button"
          onClick={downloadCsv}
          disabled={!reportQuery.data || reportQuery.data.users.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      {reportQuery.isLoading ? (
        <SkeletonList rows={5} rowClassName="h-12" />
      ) : reportQuery.isError ? (
        <QueryErrorState
          title={'Could not load the report'}
          error={reportQuery.error}
          onRetry={() => void reportQuery.refetch()}
        />
      ) : reportQuery.data && reportQuery.data.users.length === 0 ? (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title="No hours logged in this range"
          description="Try widening the range or clearing the project filter."
        />
      ) : reportQuery.data ? (
        <>
          {/* Workspace totals strip */}
          <div className="grid grid-cols-3 gap-3">
            <SummaryTile label="Total hours" value={formatHours(reportQuery.data.totals.totalSeconds)} />
            <SummaryTile label="People logged time" value={String(reportQuery.data.totals.distinctUsers)} />
            <SummaryTile label="Entries" value={String(reportQuery.data.totals.entryCount)} />
          </div>

          {/* Per-user table */}
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="grid grid-cols-[1fr_120px_80px_24px] sm:grid-cols-[2fr_120px_120px_24px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground bg-card/50 border-b border-border">
              <div>User</div>
              <div className="text-right">Hours</div>
              <div className="text-right hidden sm:block">Sessions</div>
              <div />
            </div>
            <ul className="divide-y divide-border">
              {reportQuery.data.users.map((row) => (
                <UserReportRow
                  key={row.user.id}
                  row={row}
                  expanded={expandedUserId === row.user.id}
                  onToggle={() =>
                    setExpandedUserId(expandedUserId === row.user.id ? null : row.user.id)
                  }
                />
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}

function UserReportRow({
  row,
  expanded,
  onToggle,
}: {
  row: UserRow;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="w-full grid grid-cols-[1fr_120px_80px_24px] sm:grid-cols-[2fr_120px_120px_24px] gap-2 items-center px-3 py-2.5 text-left hover:bg-accent/30 transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          <AvatarCircle user={row.user} size={28} />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate flex items-center gap-1.5">
              {row.user.name}
              {row.user.kind === 'client' && (
                <span className="text-[9px] uppercase tracking-wider px-1 py-px rounded bg-priority-medium/15 text-priority-medium font-semibold">
                  External
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">{row.user.email}</div>
          </div>
        </div>
        <div className="text-sm font-semibold tabular-nums text-right">{formatHours(row.totalSeconds)}h</div>
        <div className="text-xs text-muted-foreground tabular-nums text-right hidden sm:block">{row.entryCount}</div>
        <div className="flex justify-end text-muted-foreground">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pl-12 sm:pl-14 bg-background/40 border-t border-border/60">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 pt-2">
            Breakdown by project
          </div>
          <ul className="space-y-1">
            {row.byProject.map((p) => (
              <li
                key={p.projectId}
                className="flex items-center gap-2 text-xs py-1"
              >
                <span className="font-mono text-[10px] text-muted-foreground shrink-0">{p.key}</span>
                <span className="truncate flex-1">{p.name}</span>
                <span className="tabular-nums text-foreground/90">{formatHours(p.seconds)}h</span>
              </li>
            ))}
          </ul>
          {row.byDay.length > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-3 mb-1.5">
                Days with activity
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {row.byDay.map((d) => (
                  <li
                    key={d.date}
                    className="text-[10px] rounded border border-border bg-background/60 px-1.5 py-0.5 text-muted-foreground"
                    title={`${formatHours(d.seconds)}h on ${d.date}`}
                  >
                    <span className="tabular-nums">{d.date.slice(5)}</span>
                    <span className="ml-1 text-foreground/80 tabular-nums">{formatHours(d.seconds)}h</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-xl sm:text-2xl font-semibold tabular-nums mt-1">{value}</div>
    </div>
  );
}

function formatHours(seconds: number): string {
  // Two decimals so a 30-minute session reads as 0.50, but trim a trailing
  // .00 on whole hours so a clean 8-hour day reads as 8 (not 8.00).
  const h = seconds / 3600;
  if (Number.isInteger(h)) return String(h);
  return h.toFixed(2);
}

function csvCell(s: string): string {
  // RFC4180-style quoting: wrap if the cell contains a comma, quote, or
  // newline; escape internal quotes by doubling.
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
