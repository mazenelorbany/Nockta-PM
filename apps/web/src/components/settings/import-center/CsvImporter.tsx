import { useMutation, useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';

import { api } from '../../../lib/api';
import { apiErrorMessage } from '../primitives';
import { queryKeys } from '../../../lib/query-keys';

import { ImportProgressBar, useImportProgress } from './useImportProgress';
import { Stat } from './shared';

// =============================================================================
// CSV importer — three-step wizard (Upload → Map → Confirm).
// =============================================================================

type ImportableField =
  | 'title'
  | 'description'
  | 'priority'
  | 'type'
  | 'assigneeEmail'
  | 'dueDate'
  | 'estimate'
  | 'skip';

const IMPORTABLE_FIELD_LABELS: Record<ImportableField, string> = {
  title: 'Title (required)',
  description: 'Description',
  priority: 'Priority',
  type: 'Type',
  assigneeEmail: 'Assignee (email)',
  dueDate: 'Due date',
  estimate: 'Estimate',
  skip: '— skip this column —',
};

interface CsvPreviewResponse {
  headers: string[];
  rowCount: number;
  sampleRows: string[][];
}

interface CommitResponseShape {
  dryRun: boolean;
  runId?: string;
  totalRows: number;
  createdCount: number;
  skippedCount: number;
  errors: { rowIndex: number; reason: string }[];
}

export function CsvImporter(): JSX.Element {
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<Array<{ id: string; key: string; name: string }>>('/projects'),
  });
  const projects = projectsQuery.data ?? [];

  const [projectId, setProjectId] = useState('');
  const [fileName, setFileName] = useState('');
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<CsvPreviewResponse | null>(null);
  const [mapping, setMapping] = useState<Record<number, ImportableField>>({});
  const [step, setStep] = useState<'upload' | 'map' | 'confirm' | 'running' | 'done'>('upload');
  const [dryRun, setDryRun] = useState<CommitResponseShape | null>(null);
  const [committed, setCommitted] = useState<CommitResponseShape | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const progress = useImportProgress(activeRunId);

  const parseMutation = useMutation({
    mutationFn: (text: string) =>
      api.post<CsvPreviewResponse>('/import/csv/parse', { csvText: text }),
    onSuccess: (resp) => {
      setPreview(resp);
      const auto: Record<number, ImportableField> = {};
      resp.headers.forEach((h, i) => {
        auto[i] = guessField(h);
      });
      setMapping(auto);
      setStep('map');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not read CSV')),
  });

  const commitMutation = useMutation({
    mutationFn: (input: { dryRun: boolean }) =>
      api.post<CommitResponseShape>('/import/csv/commit', {
        projectId,
        csvText,
        mapping,
        dryRun: input.dryRun,
      }),
    onSuccess: (resp) => {
      if (resp.dryRun) {
        setDryRun(resp);
        setStep('confirm');
      } else {
        setCommitted(resp);
        if (resp.runId) setActiveRunId(resp.runId);
        setStep('done');
        toast.success(
          `Imported ${resp.createdCount} task${resp.createdCount === 1 ? '' : 's'}`,
        );
      }
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Import failed')),
  });

  async function handleFile(file: File): Promise<void> {
    const text = await file.text();
    setFileName(file.name);
    setCsvText(text);
    parseMutation.mutate(text);
  }

  function reset(): void {
    setFileName('');
    setCsvText('');
    setPreview(null);
    setMapping({});
    setDryRun(null);
    setCommitted(null);
    setActiveRunId(null);
    setStep('upload');
  }

  return (
    <div className="rounded-lg border border-border bg-card/40 p-5 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-md bg-brand/10 text-brand flex items-center justify-center">
            <FileSpreadsheet className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">CSV import</h3>
            <p className="text-xs text-muted-foreground">
              {fileName
                ? `${fileName} · ${preview?.rowCount ?? '—'} rows`
                : 'Tab-delimited or comma-delimited; headers in the first row.'}
            </p>
          </div>
        </div>
        {step !== 'upload' && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Start over
          </button>
        )}
      </div>

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
              {projectId ? 'Drop a CSV here, or click to browse' : 'Pick a project first'}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Max ~5MB. We support CSVs from Excel, Google Sheets, Jira's Issue exporter, and Linear.
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

      {step === 'map' && preview && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Match each CSV column to a Nockta task field.{' '}
            <span className="text-foreground font-medium">Title</span> is required; the rest are optional.
            Skip columns you don't want imported.
          </p>
          <div className="rounded-md border border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-secondary/40">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">CSV column</th>
                  <th className="text-left px-3 py-2 font-medium">Sample values</th>
                  <th className="text-left px-3 py-2 font-medium">Maps to</th>
                </tr>
              </thead>
              <tbody>
                {preview.headers.map((h, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-2 font-mono">{h}</td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-[280px]">
                      {preview.sampleRows
                        .map((r) => r[i] ?? '')
                        .filter(Boolean)
                        .slice(0, 5)
                        .join('  ·  ') || <span className="opacity-50">(empty)</span>}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={mapping[i] ?? 'skip'}
                        onChange={(e) =>
                          setMapping((m) => ({ ...m, [i]: e.target.value as ImportableField }))
                        }
                        className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        {(Object.keys(IMPORTABLE_FIELD_LABELS) as ImportableField[]).map((f) => (
                          <option key={f} value={f}>
                            {IMPORTABLE_FIELD_LABELS[f]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {Object.values(mapping).includes('title') && (
            <div>
              <div className="nockta-eyebrow text-muted-foreground mb-2">
                First {Math.min(5, preview.sampleRows.length)} row
                {preview.sampleRows.length === 1 ? '' : 's'} — how they'll be interpreted
              </div>
              <div className="rounded-md border border-border bg-background/40 divide-y divide-border">
                {preview.sampleRows.slice(0, 5).map((row, rowIdx) => (
                  <div
                    key={rowIdx}
                    className="p-3 text-xs grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5"
                  >
                    {preview.headers.map((_, colIdx) => {
                      const fieldKey = mapping[colIdx] ?? 'skip';
                      if (fieldKey === 'skip') return null;
                      const value = row[colIdx];
                      const label = IMPORTABLE_FIELD_LABELS[fieldKey];
                      return (
                        <div key={colIdx} className="flex items-baseline gap-2 min-w-0">
                          <span className="nockta-eyebrow text-muted-foreground/70 shrink-0">
                            {label}
                          </span>
                          <span className="text-foreground truncate">
                            {value ?? <span className="opacity-50">(empty)</span>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => commitMutation.mutate({ dryRun: true })}
              disabled={
                commitMutation.isPending ||
                !Object.values(mapping).includes('title')
              }
              className="rounded-md bg-foreground px-4 py-2 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50 transition"
              title={
                Object.values(mapping).includes('title')
                  ? 'Validate every row before committing'
                  : 'Map a column to Title first'
              }
            >
              {commitMutation.isPending ? 'Checking…' : 'Preview import'}
            </button>
          </div>
        </div>
      )}

      {step === 'confirm' && dryRun && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Rows" value={dryRun.totalRows} />
            <Stat label="Will create" value={dryRun.createdCount} tone="primary" />
            <Stat
              label={dryRun.errors.length > 0 ? 'Errors' : 'Skipped'}
              value={dryRun.errors.length > 0 ? dryRun.errors.length : dryRun.skippedCount}
              tone={dryRun.errors.length > 0 ? 'danger' : undefined}
            />
          </div>
          {dryRun.errors.length > 0 && (
            <div className="rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3">
              <p className="text-xs font-medium text-status-blocked mb-2">
                Fix these rows in your CSV and re-upload — commits are all-or-nothing.
              </p>
              <ul className="space-y-1 max-h-40 overflow-y-auto text-xs">
                {dryRun.errors.map((e) => (
                  <li key={`${e.rowIndex}-${e.reason}`} className="flex gap-2">
                    <span className="font-mono text-muted-foreground shrink-0">
                      row {e.rowIndex}:
                    </span>
                    <span>{e.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {dryRun.errors.length === 0 && dryRun.createdCount > 0 && (
            <div className="rounded-md border border-status-done/40 bg-status-done/10 p-3 text-xs">
              Ready to import {dryRun.createdCount} tasks into the selected project. This can't be
              undone — but you can archive or delete the tasks afterward.
            </div>
          )}
          {commitMutation.isPending && activeRunId && progress.done === 'running' && (
            <ImportProgressBar
              processed={progress.processed}
              total={progress.total || dryRun.createdCount}
              done={progress.done}
            />
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('map')}
              disabled={commitMutation.isPending}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent transition disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => commitMutation.mutate({ dryRun: false })}
              disabled={
                commitMutation.isPending || dryRun.errors.length > 0 || dryRun.createdCount === 0
              }
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 transition"
            >
              {commitMutation.isPending ? 'Importing…' : `Import ${dryRun.createdCount} tasks`}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && committed && (
        <div className="rounded-md border border-status-done/40 bg-status-done/10 p-4 space-y-2">
          <p className="text-sm font-semibold">
            Imported {committed.createdCount} tasks · skipped {committed.skippedCount}
          </p>
          <p className="text-xs text-muted-foreground">
            They've been added to the project. New events fire for every row, so watchers and the
            activity timeline are already up to date.
          </p>
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={reset}
              className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
            >
              Import another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function guessField(header: string): ImportableField {
  const h = header.toLowerCase().trim();
  if (/^(title|summary|name)$/.test(h)) return 'title';
  if (/^(description|details|body)$/.test(h)) return 'description';
  if (/^(priority|prio)$/.test(h)) return 'priority';
  if (/^(type|issue ?type|kind)$/.test(h)) return 'type';
  if (/(assignee.*email|owner.*email|email)/.test(h)) return 'assigneeEmail';
  if (/^(due.*date|due)$/.test(h)) return 'dueDate';
  if (/^(estimate|points|story.?points)$/.test(h)) return 'estimate';
  return 'skip';
}
