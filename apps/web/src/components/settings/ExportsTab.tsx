import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';

import { AdminGate, SectionTitle, apiErrorMessage } from './primitives';
import { CreateExportForm } from './exports-tab/CreateExportForm';
import { RecentRunsSubview } from './exports-tab/RecentRunsSubview';
import { SchedulesTable } from './exports-tab/SchedulesTable';
import type { ExportRun, ExportSchedule } from './exports-tab/types';

// =============================================================================
// ExportsTab — workspace-level scheduled / on-demand data exports.
//
// Distinct from the ad-hoc "download this view as CSV" buttons scattered
// across the analytics surface: that flow short-circuits with a single
// generate-and-download. This tab is the persistence layer — the user
// authors an ExportSchedule (CSV, XLSX, or PDF; saved view / project /
// all tasks; one-off OR cron) and the API materialises runs on the
// configured cadence. Recent runs are downloadable for 24h.
//
// Surface:
//   - Scheduled exports list (name, kind, source, schedule, last run, status,
//     enable/run/delete actions).
//   - "New export" modal: source + kind + schedule + delivery pickers.
//   - Recent runs subview: status badge, row count, and a download button
//     for completed runs whose signed URL hasn't expired.
//
// The workspace scope is derived server-side from the JWT (same pattern as
// WebhooksTab) — the client never sends a workspaceId.
// =============================================================================

export function ExportsTab({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  if (!isAdmin) return <AdminGate />;
  return <ExportsTabAdmin />;
}

function ExportsTabAdmin(): JSX.Element {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [showRuns, setShowRuns] = useState(false);

  const schedulesQuery = useQuery({
    queryKey: ['exports-schedules'],
    queryFn: () => api.get<ExportSchedule[]>(`/exports/schedules`),
  });

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<ExportSchedule>(`/exports/schedules/${id}`, { enabled }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['exports-schedules'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update schedule')),
  });

  const removeSchedule = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/exports/schedules/${id}`),
    onSuccess: () => {
      toast.success('Export schedule deleted');
      void qc.invalidateQueries({ queryKey: ['exports-schedules'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete schedule')),
  });

  const runOnce = useMutation({
    mutationFn: (id: string) => api.post<ExportRun>(`/exports/schedules/${id}/run`, {}),
    onSuccess: () => {
      toast.success('Export queued — refresh Recent runs to see progress');
      void qc.invalidateQueries({ queryKey: ['exports-runs'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not start export')),
  });

  const schedules = schedulesQuery.data ?? [];

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <SectionTitle
          title="Data exports"
          hint="Schedule recurring CSV / XLSX / PDF reports or run a one-off export."
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowRuns((s) => !s)}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent/40 transition-colors"
          >
            {showRuns ? 'Hide recent runs' : 'Recent runs'}
          </button>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-md border border-border bg-brand text-brand-foreground px-3 py-1.5 text-xs font-medium hover:bg-brand/90 transition-colors"
          >
            New export
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateExportForm
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void qc.invalidateQueries({ queryKey: ['exports-schedules'] });
          }}
        />
      )}

      {schedulesQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading schedules…</div>
      ) : schedules.length === 0 ? (
        <EmptyState />
      ) : (
        <SchedulesTable
          schedules={schedules}
          onToggle={(id, enabled) => toggleEnabled.mutate({ id, enabled })}
          onDelete={(id, name) => {
            if (window.confirm(`Delete export "${name}"?`)) removeSchedule.mutate(id);
          }}
          onRun={(id) => runOnce.mutate(id)}
        />
      )}

      {showRuns && <RecentRunsSubview />}
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/20 p-8 text-center">
      <div className="text-sm font-medium">No exports yet</div>
      <div className="text-xs text-muted-foreground mt-1">
        Schedule a recurring CSV / XLSX / PDF report or generate one on demand.
      </div>
    </div>
  );
}
