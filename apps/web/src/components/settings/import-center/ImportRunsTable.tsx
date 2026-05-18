import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, GitBranch, Github, RefreshCw, Zap } from 'lucide-react';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';
import { api } from '../../../lib/api';
import { apiErrorMessage } from '../primitives';
import { StatusBadge } from './shared';
import type { ImportRunSummary } from './types';

// =============================================================================
// ImportRunsTable — last 20 runs, sortable by start time, with a re-run button.
// =============================================================================

export function ImportRunsTable({
  onRerun,
}: {
  onRerun: (run: ImportRunSummary) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const runsQuery = useQuery({
    queryKey: ['import-runs'],
    queryFn: () => api.get<ImportRunSummary[]>('/import/runs?limit=20'),
    refetchInterval: 5000,
  });
  const runs = runsQuery.data ?? [];

  // Pass D — partial-fail Resume affordance. Visible only for runs that
  // ended in `failed` and have a non-null resumableFromRow. The endpoint
  // restarts from `resumableFromRow + 1` server-side; the UI optimistically
  // marks the row as running and invalidates the list on response.
  const resumeMutation = useMutation({
    mutationFn: (runId: string) =>
      api.post<{ runId: string; createdCount: number }>(`/import/${runId}/resume`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['import-runs'] });
      toast.success('Resumed — replaying the remaining rows.');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Resume failed')),
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Recent runs</h3>
        <button
          type="button"
          onClick={() => void runsQuery.refetch()}
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>
      <div className="rounded-md border border-border overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-secondary/40">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium">Source</th>
              <th className="text-left px-2 py-1.5 font-medium">Ref</th>
              <th className="text-left px-2 py-1.5 font-medium">Status</th>
              <th className="text-right px-2 py-1.5 font-medium">Created</th>
              <th className="text-right px-2 py-1.5 font-medium">Skipped</th>
              <th className="text-right px-2 py-1.5 font-medium">Errored</th>
              <th className="text-left px-2 py-1.5 font-medium">Started</th>
              <th className="text-right px-2 py-1.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {runsQuery.isLoading && (
              <tr>
                <td colSpan={8} className="px-2 py-4 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!runsQuery.isLoading && runs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-4 text-center text-muted-foreground">
                  No imports yet — kick one off above.
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-2 py-1.5">
                  <span className="inline-flex items-center gap-1 font-medium">
                    {r.source === 'csv' && <FileSpreadsheet className="h-3 w-3" />}
                    {r.source === 'linear' && <Zap className="h-3 w-3" />}
                    {r.source === 'jira' && <GitBranch className="h-3 w-3" />}
                    {r.source === 'github_issues' && <Github className="h-3 w-3" />}
                    {r.source === 'github_issues' ? 'GitHub' : r.source}
                  </span>
                </td>
                <td className="px-2 py-1.5 font-mono text-muted-foreground">
                  {r.sourceRef ?? '—'}
                </td>
                <td className="px-2 py-1.5">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.createdRows}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                  {r.skippedRows}
                </td>
                <td
                  className={cn(
                    'px-2 py-1.5 text-right tabular-nums',
                    r.erroredRows > 0 ? 'text-status-blocked' : 'text-muted-foreground',
                  )}
                >
                  {r.erroredRows}
                </td>
                <td className="px-2 py-1.5 text-muted-foreground">
                  {new Date(r.startedAt).toLocaleString()}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <div className="inline-flex items-center gap-3">
                    {r.status === 'failed' &&
                      r.resumableFromRow !== null &&
                      r.resumableFromRow !== undefined && (
                        <button
                          type="button"
                          onClick={() => resumeMutation.mutate(r.id)}
                          disabled={resumeMutation.isPending}
                          title={
                            r.lastError
                              ? `Resume from row ${r.resumableFromRow + 2}. Last error: ${r.lastError}`
                              : `Resume from row ${r.resumableFromRow + 2}`
                          }
                          className="text-xs text-primary hover:opacity-80 disabled:opacity-30 inline-flex items-center gap-1"
                        >
                          <RefreshCw className="h-3 w-3" />
                          Resume
                        </button>
                      )}
                    <button
                      type="button"
                      onClick={() => onRerun(r)}
                      disabled={!r.mappingSnapshot || r.source === 'csv'}
                      title={
                        r.source === 'csv'
                          ? 'CSV runs re-upload the file; nothing to replay'
                          : 'Re-open with the prior mapping pre-filled'
                      }
                      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 inline-flex items-center gap-1"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Re-run
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
