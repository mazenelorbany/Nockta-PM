import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { cn } from '@nockta/ui';

import { api } from '../../../lib/api';
import { Fieldset } from '../primitives';

import type { ExportRun } from './types';

// =============================================================================
// Recent runs subview
// =============================================================================

export function RecentRunsSubview(): JSX.Element {
  const runsQuery = useQuery({
    queryKey: ['exports-runs'],
    queryFn: () => api.get<ExportRun[]>(`/exports/runs?take=50`),
    refetchInterval: 4_000,
  });
  const runs = runsQuery.data ?? [];
  return (
    <Fieldset legend="Recent runs" hint="The 50 most recent export runs across this workspace.">
      {runsQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading runs…</div>
      ) : runs.length === 0 ? (
        <div className="text-xs text-muted-foreground">No runs yet — start one from a schedule above.</div>
      ) : (
        <ul className="space-y-1">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      )}
    </Fieldset>
  );
}

function RunRow({ run }: { run: ExportRun }): JSX.Element {
  const tone =
    run.status === 'completed'
      ? 'bg-status-done/15 text-status-done'
      : run.status === 'failed'
        ? 'bg-destructive/15 text-destructive'
        : run.status === 'running'
          ? 'bg-status-blocked/15 text-status-blocked'
          : 'bg-muted text-muted-foreground';

  // A run is downloadable when status is 'completed' AND the expiresAt
  // timestamp (24h after creation, set server-side) is still in the future.
  // We compute this once per render instead of polling — the parent's
  // refetchInterval handles long-running queues.
  const downloadable = useMemo(() => {
    if (run.status !== 'completed') return false;
    if (!run.signedUrl) return false;
    if (!run.expiresAt) return true;
    return new Date(run.expiresAt).getTime() > Date.now();
  }, [run]);

  return (
    <li className="rounded border border-border bg-background/40 px-2.5 py-2 text-xs flex items-center gap-3">
      <span className={cn('text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 shrink-0', tone)}>
        {run.status}
      </span>
      <span className="font-mono uppercase text-[10px] shrink-0">{run.kind}</span>
      <span className="text-muted-foreground text-[10px] shrink-0">
        {new Date(run.createdAt).toLocaleString()}
      </span>
      {run.rowCount > 0 && (
        <span className="text-muted-foreground text-[10px] shrink-0">{run.rowCount} rows</span>
      )}
      <span className="flex-1 truncate text-muted-foreground">
        {run.errorMessage ?? (run.sourceKind ? `source: ${run.sourceKind}` : '')}
      </span>
      {downloadable && run.signedUrl && (
        <a
          href={run.signedUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] hover:bg-accent/40 transition-colors"
        >
          Download
        </a>
      )}
    </li>
  );
}
