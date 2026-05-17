import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cn, EmptyState, NocktaMark, QueryErrorState, SkeletonList,
} from '@nockta/ui';
import { Users as UsersIcon } from 'lucide-react';
import { AvatarCircle } from '../components/task-bits';
import { api } from '../lib/api';

// =============================================================================
// /workload — cross-project capacity view. Each row is one person with an
// open-task count, a stacked priority bar, and a "load score" that weights
// Critical 4x / High 3x / Medium 2x / Low 1x. Filterable by project + team.
// =============================================================================

interface WorkloadRow {
  userId: string;
  total: number;
  points: number;
  byPriority: { Critical: number; High: number; Medium: number; Low: number };
  loadScore: number;
  user: { id: string; name: string; email: string; avatarUrl: string | null } | null;
  /** Open-task count snapshot for each of the last 7 days (oldest → newest). */
  series?: number[];
}

interface WorkloadResp {
  rows: WorkloadRow[];
}

interface ProjectLite { id: string; key: string; name: string }
interface TeamLite { id: string; name: string; slug: string }

export function WorkloadPage(): JSX.Element {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState('');
  const [teamId, setTeamId] = useState('');
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectLite[]>('/projects'),
  });
  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<TeamLite[]>('/teams'),
  });
  const qs = new URLSearchParams();
  if (projectId) qs.set('projectId', projectId);
  if (teamId) qs.set('teamId', teamId);
  const workloadQuery = useQuery({
    queryKey: ['workload', qs.toString()],
    queryFn: () => api.get<WorkloadResp>(`/analytics/workload?${qs.toString()}`),
  });

  const rows = workloadQuery.data?.rows ?? [];
  // Use the max load score as the scale; protect against zero.
  const maxLoad = Math.max(1, ...rows.map((r) => r.loadScore));

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
          <span className="nockta-eyebrow text-brand">{t('nav.workspace', 'Workspace')}</span>
          <h1
            className="display-heading mt-2 leading-[1.04]"
            style={{ fontSize: 'clamp(1.8rem, 3.4vw, 2.6rem)' }}
          >
            {t('nav.workload', 'Workload')}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {t(
              'workload.subtitle',
              "Who's loaded with what. Priority-weighted scoring across every open task — Critical counts as 4×, High 3×, Medium 2×, Low 1×.",
            )}
          </p>
        </div>
      </header>

      <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <Pill
          label={t('notifications_bell.filter_project', 'Project')}
          value={projectId}
          onChange={setProjectId}
          options={[
            { value: '', label: t('inbox.all_projects', 'All projects') },
            ...(projectsQuery.data ?? []).map((p) => ({ value: p.id, label: `${p.key} — ${p.name}` })),
          ]}
        />
        <Pill
          label={t('workload.team', 'Team')}
          value={teamId}
          onChange={setTeamId}
          options={[
            { value: '', label: t('workload.everyone', 'Everyone') },
            ...(teamsQuery.data ?? []).map((teamItem) => ({ value: teamItem.id, label: teamItem.name })),
          ]}
        />
        {(projectId || teamId) && (
          <button
            type="button"
            onClick={() => {
              setProjectId('');
              setTeamId('');
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
        <span className="nockta-eyebrow text-muted-foreground ml-auto">
          {rows.length} {rows.length === 1 ? 'person' : 'people'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 md:px-8 py-4 sm:py-6">
        {workloadQuery.isLoading ? (
          <SkeletonList rows={6} rowClassName="h-16" />
        ) : workloadQuery.isError ? (
          <QueryErrorState
            title="Couldn't load workload"
            error={workloadQuery.error}
            onRetry={() => void workloadQuery.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<UsersIcon className="h-5 w-5" />}
            title="No open work in this view"
            description="Either nobody on this team has an open task right now, or the filters are too tight. Clear them to see the full org."
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <WorkloadRowItem key={r.userId} row={r} maxLoad={maxLoad} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function WorkloadRowItem({ row, maxLoad }: { row: WorkloadRow; maxLoad: number }): JSX.Element {
  const widthPct = (row.loadScore / maxLoad) * 100;
  // Stacked bar — split widthPct across priorities proportional to their counts.
  const total = row.total || 1;
  const segments: { key: keyof WorkloadRow['byPriority']; color: string }[] = [
    { key: 'Critical', color: 'bg-priority-critical' },
    { key: 'High', color: 'bg-priority-high' },
    { key: 'Medium', color: 'bg-priority-medium' },
    { key: 'Low', color: 'bg-priority-low' },
  ];

  return (
    <li className="grid grid-cols-[200px_1fr_220px] gap-4 items-center rounded-lg border border-border bg-card/40 px-4 py-3">
      <div className="flex items-center gap-2 min-w-0">
        {row.user ? (
          <>
            <AvatarCircle user={row.user} size={26} />
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{row.user.name}</p>
              <p className="text-[10px] text-muted-foreground truncate">{row.user.email}</p>
            </div>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">Unknown</span>
        )}
      </div>

      <div>
        <div className="h-3 rounded-full bg-secondary/50 overflow-hidden flex">
          {segments.map((s) => {
            const count = row.byPriority[s.key];
            if (count === 0) return null;
            const pct = (count / total) * widthPct;
            return (
              <div
                key={s.key}
                className={cn(s.color)}
                style={{ width: `${pct}%` }}
                title={`${s.key}: ${count}`}
              />
            );
          })}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          {segments.map((s) => row.byPriority[s.key] > 0 && (
            <span key={s.key} className="inline-flex items-center gap-1">
              <span className={cn('h-1.5 w-1.5 rounded-full', s.color)} />
              {s.key} {row.byPriority[s.key]}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        <Sparkline series={row.series ?? [row.total]} />
        <div className="text-right text-xs">
          <p className="font-semibold tabular-nums">{row.total} open</p>
          <p className="text-muted-foreground tabular-nums">{row.points} pts · load {row.loadScore}</p>
        </div>
      </div>
    </li>
  );
}

/**
 * Inline SVG sparkline of the last-7-days open-task series. Width ~80px,
 * height ~20px. Brand-coloured stroke, no chart library — just a polyline
 * over the N points (with min/max normalised to the bounding box).
 */
function Sparkline({ series }: { series: number[] }): JSX.Element {
  const W = 80;
  const H = 20;
  const PAD = 1;
  const pts = series.length > 0 ? series : [0];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const stepX = pts.length > 1 ? (W - PAD * 2) / (pts.length - 1) : 0;
  const coords = pts.map((v, i) => {
    const x = PAD + i * stepX;
    // Invert Y so larger values sit at the top.
    const y = PAD + (H - PAD * 2) * (1 - (v - min) / range);
    return [x, y] as const;
  });
  // If every value is the same, draw a flat horizontal mid-line so the row
  // still feels alive (the path would otherwise be at y=PAD because of the
  // 1-(v-min)/range collapse).
  const flat = min === max;
  const path = coords
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${flat ? (H / 2).toFixed(1) : y.toFixed(1)}`)
    .join(' ');
  const last = coords[coords.length - 1];
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="text-brand shrink-0"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {last && (
        <circle
          cx={last[0]}
          cy={flat ? H / 2 : last[1]}
          r={1.6}
          fill="currentColor"
        />
      )}
    </svg>
  );
}

function Pill({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  const isActive = value !== '';
  const current = options.find((o) => o.value === value);
  return (
    <label
      className={cn(
        'relative inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer transition-colors',
        isActive
          ? 'border-brand/40 bg-accent text-foreground'
          : 'border-border bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="nockta-eyebrow text-[0.6rem] opacity-60">{label}</span>
      {isActive && <span className="truncate max-w-[140px]">{current?.label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
