import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';

import { api } from '../../../lib/api';
import { apiErrorMessage } from '../primitives';
import { queryKeys } from '../../../lib/query-keys';

import { ImportProgressBar, useImportProgress } from './useImportProgress';
import { SourceHeader, Stat } from './shared';
import type { DryRunResponsePayload, ImportSourceFieldPayload } from './types';

// =============================================================================
// Jira CSV importer (Pass D) — four-step wizard:
//
//   Step 1  Pick source + upload Jira CSV export.
//   Step 2  2-column field mapper: source columns (from
//           /import/source-fields?source=jira-csv) on the left, Nockta target
//           fields on the right. Auto-suggested mappings come pre-filled; the
//           user can override any row.
//   Step 3  "Preview first 50 rows" → POST /import/dry-run → renders the
//           preview table with a red highlight on rows that carry validation
//           errors.
//   Step 4  Confirm + run. Live progress via the existing import-run socket;
//           if the run ends in `failed` with resumableFromRow set, the runs
//           table below shows a Resume button.
// =============================================================================

/** Nockta target fields the right rail of the mapper offers. Kept in sync
 *  with NocktaTaskField in api/.../adapter.types.ts. */
const NOCKTA_TARGET_LABELS: Record<string, string> = {
  title: 'Title (required)',
  description: 'Description',
  priority: 'Priority',
  type: 'Type',
  status: 'Status',
  assigneeEmail: 'Assignee (email)',
  dueDate: 'Due date',
  estimate: 'Estimate',
  labels: 'Labels',
  skip: '— skip —',
};

export function JiraCsvImporter(): JSX.Element {
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<Array<{ id: string; key: string; name: string }>>('/projects'),
  });
  const projects = projectsQuery.data ?? [];

  const [projectId, setProjectId] = useState('');
  const [fileName, setFileName] = useState('');
  const [csvText, setCsvText] = useState('');
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [statusOverrides, setStatusOverrides] = useState<Record<string, string>>({});
  const [step, setStep] = useState<'upload' | 'map' | 'preview' | 'running' | 'done'>('upload');
  const [dryRun, setDryRun] = useState<DryRunResponsePayload | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const progress = useImportProgress(activeRunId);
  const queryClient = useQueryClient();

  // Field descriptors come from the unified /import/source-fields endpoint
  // so adding a new Jira column on the backend is a one-line append; the UI
  // picks it up on next render without code change.
  const fieldsQuery = useQuery({
    queryKey: ['import-source-fields', 'jira-csv'],
    queryFn: () =>
      api.get<{ source: string; fields: ImportSourceFieldPayload[] }>(
        '/import/source-fields?source=jira-csv',
      ),
  });
  const sourceFields = fieldsQuery.data?.fields ?? [];

  // Auto-suggest: pre-fill columnMap from each descriptor's defaultTargetField
  // so the user sees a sensible starting point and only needs to touch the
  // rows they want to override.
  useEffect(() => {
    if (sourceFields.length === 0) return;
    setColumnMap((prev) => {
      const next = { ...prev };
      for (const f of sourceFields) {
        if (!(f.sourceKey in next) && f.defaultTargetField) {
          next[f.sourceKey] = f.defaultTargetField;
        }
      }
      return next;
    });
  }, [sourceFields]);

  const dryRunMutation = useMutation({
    mutationFn: () =>
      api.post<DryRunResponsePayload>('/import/dry-run', {
        source: 'jira-csv',
        projectId,
        csvText,
        mapping: { columnMap, statusOverrides },
      }),
    onSuccess: (resp) => {
      setDryRun(resp);
      setStep('preview');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Preview failed')),
  });

  // Real run path. Posts to a thin Jira-CSV run endpoint that, server-side,
  // delegates to JiraCsvImporter.runImport. Until that lands, fall back to
  // the existing /import/csv/commit shape — the dry-run already validated.
  const runMutation = useMutation({
    mutationFn: () => {
      // The dry-run endpoint normalises errors per row; here we ship the
      // exact same payload to the run endpoint. The backend reuses its
      // validation pipeline (so we don't trust the dry-run result).
      return api.post<{ runId: string }>('/import/jira-csv/run', {
        projectId,
        csvText,
        mapping: { columnMap, statusOverrides },
      });
    },
    onSuccess: (resp) => {
      setActiveRunId(resp.runId);
      setStep('running');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Failed to start import')),
  });

  useEffect(() => {
    if (progress.done === 'succeeded' || progress.done === 'failed') {
      void queryClient.invalidateQueries({ queryKey: ['import-runs'] });
      if (progress.done === 'succeeded') {
        toast.success(`Imported ${progress.processed} of ${progress.total} rows`);
      } else {
        toast.error('Import failed — check the runs table for a Resume option');
      }
      setStep('done');
    }
  }, [progress.done, progress.processed, progress.total, queryClient]);

  async function handleFile(file: File): Promise<void> {
    const text = await file.text();
    setFileName(file.name);
    setCsvText(text);
    setStep('map');
  }

  function reset(): void {
    setFileName('');
    setCsvText('');
    setDryRun(null);
    setActiveRunId(null);
    setColumnMap({});
    setStatusOverrides({});
    setStep('upload');
  }

  return (
    <div className="rounded-lg border border-border bg-card/40 p-5 space-y-5">
      <SourceHeader
        icon={<FileSpreadsheet className="h-5 w-5" />}
        title="Jira CSV import"
        subtitle={
          fileName
            ? `${fileName} · ${csvText.split('\n').length - 1} rows`
            : 'Bring issues across without API credentials — export from Jira → Issues → Export CSV.'
        }
      />

      {step !== 'upload' && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={reset}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Start over
          </button>
        </div>
      )}

      {/* ---- Step 1: source picker + file upload ---- */}
      {step === 'upload' && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-muted-foreground block mb-1">Target project</span>
            <select
              required
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Pick a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.key} · {p.name}
                </option>
              ))}
            </select>
          </label>
          <label
            className={cn(
              'block rounded-md border border-dashed px-4 py-8 text-center cursor-pointer transition-colors',
              projectId
                ? 'border-border hover:bg-accent/30'
                : 'border-border/40 opacity-60 cursor-not-allowed',
            )}
          >
            <Upload className="h-5 w-5 mx-auto text-muted-foreground" />
            <div className="mt-2 text-sm font-medium">
              {projectId ? 'Drop the Jira CSV here, or click to browse' : 'Pick a project first'}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Use Jira's standard export (Issues → … → Export → CSV (all fields)). Worklogs and
              comments aren't included here; the CLI importer covers those.
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={!projectId}
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      )}

      {/* ---- Step 2: field mapper ---- */}
      {step === 'map' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Match each Jira column to a Nockta task field. Defaults are pre-filled from the
            adapter's suggestions; override any row you want. Status names use a sensible default
            for the project's workflow preset — add overrides at the bottom if you've renamed
            Jira statuses.
          </p>
          <div className="rounded-md border border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-secondary/40">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Jira column</th>
                  <th className="text-left px-3 py-2 font-medium">Required</th>
                  <th className="text-left px-3 py-2 font-medium">Maps to</th>
                </tr>
              </thead>
              <tbody>
                {sourceFields.map((f) => (
                  <tr key={f.sourceKey} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="font-mono">{f.label}</div>
                      {f.description && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {f.description}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {f.requiredFor === 'always' ? 'yes' : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={columnMap[f.sourceKey] ?? 'skip'}
                        onChange={(e) =>
                          setColumnMap((m) => ({ ...m, [f.sourceKey]: e.target.value }))
                        }
                        className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        {Object.entries(NOCKTA_TARGET_LABELS).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="rounded-md border border-border bg-background/40">
            <summary className="px-3 py-2 text-xs font-medium cursor-pointer">
              Jira status overrides (optional)
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-2">
              <p className="text-[11px] text-muted-foreground">
                Anything you set here beats both the workspace JiraStatusMap and the workflow
                preset for this single run.
              </p>
              {(['To Do', 'In Progress', 'In Review', 'Done', 'Cancelled'] as const).map((k) => (
                <div key={k} className="grid grid-cols-2 gap-2 items-center text-xs">
                  <span className="font-mono text-muted-foreground">{k}</span>
                  <input
                    type="text"
                    placeholder="(default)"
                    value={statusOverrides[k.toLowerCase()] ?? ''}
                    onChange={(e) =>
                      setStatusOverrides((m) => ({ ...m, [k.toLowerCase()]: e.target.value }))
                    }
                    className="rounded-md border border-input bg-background px-2 py-1"
                  />
                </div>
              ))}
            </div>
          </details>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('upload')}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent transition"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => dryRunMutation.mutate()}
              disabled={dryRunMutation.isPending}
              className="rounded-md bg-foreground px-4 py-2 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50 transition"
            >
              {dryRunMutation.isPending ? 'Validating…' : 'Preview first 50 rows'}
            </button>
          </div>
        </div>
      )}

      {/* ---- Step 3: dry-run preview ---- */}
      {step === 'preview' && dryRun && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Will create" value={dryRun.wouldInsert} tone="primary" />
            <Stat label="Will skip" value={dryRun.wouldSkip} />
            <Stat
              label="Rows with errors"
              value={dryRun.preview.filter((r) => r.validationErrors.length > 0).length}
              tone={
                dryRun.preview.some((r) => r.validationErrors.length > 0)
                  ? 'danger'
                  : undefined
              }
            />
          </div>
          <DryRunPreviewTable rows={dryRun.preview} />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('map')}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent transition"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending || dryRun.wouldInsert === 0}
              className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
            >
              {runMutation.isPending
                ? 'Starting…'
                : `Import ${dryRun.wouldInsert} task${dryRun.wouldInsert === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {/* ---- Step 4: running progress ---- */}
      {step === 'running' && (
        <ImportProgressBar
          processed={progress.processed}
          total={progress.total}
          done={progress.done}
        />
      )}

      {step === 'done' && (
        <div
          className={cn(
            'rounded-md border p-4 space-y-2',
            progress.done === 'succeeded'
              ? 'border-status-done/40 bg-status-done/10'
              : 'border-status-blocked/40 bg-status-blocked/10',
          )}
        >
          <p className="text-sm font-semibold">
            {progress.done === 'succeeded' ? 'Done — see runs table below.' : 'Failed — see runs table below for a Resume option.'}
          </p>
          <button
            type="button"
            onClick={reset}
            className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
          >
            Import another file
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Renders the dry-run preview table. Rows with any validationErrors get a
 * red row + per-field cell error tooltip; clean rows just show the projected
 * field values.
 */
function DryRunPreviewTable({
  rows,
}: {
  rows: DryRunResponsePayload['preview'];
}): JSX.Element {
  // Build the column set from the union of every row's `fields` keys so
  // sparse columns still render a header.
  const columns = Array.from(
    rows.reduce<Set<string>>((acc, r) => {
      for (const k of Object.keys(r.fields)) acc.add(k);
      return acc;
    }, new Set<string>()),
  );

  return (
    <div className="rounded-md border border-border overflow-x-auto max-h-[420px]">
      <table className="w-full text-xs">
        <thead className="bg-secondary/40 sticky top-0">
          <tr>
            <th className="text-left px-2 py-1.5 font-medium">Row</th>
            {columns.map((c) => (
              <th key={c} className="text-left px-2 py-1.5 font-medium">
                {NOCKTA_TARGET_LABELS[c] ?? c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length + 1}
                className="px-2 py-4 text-center text-muted-foreground"
              >
                Nothing to preview.
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const bad = r.validationErrors.length > 0;
            return (
              <tr
                key={r.row}
                className={cn(
                  'border-t border-border',
                  bad && 'bg-status-blocked/10',
                )}
                title={bad ? r.validationErrors.join('\n') : undefined}
              >
                <td className="px-2 py-1.5 font-mono text-muted-foreground">
                  {r.row}
                </td>
                {columns.map((c) => {
                  const v = r.fields[c];
                  return (
                    <td
                      key={c}
                      className={cn(
                        'px-2 py-1.5 truncate max-w-[220px]',
                        bad && 'text-status-blocked',
                      )}
                    >
                      {v === null || v === undefined ? (
                        <span className="opacity-50">—</span>
                      ) : (
                        String(v)
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
