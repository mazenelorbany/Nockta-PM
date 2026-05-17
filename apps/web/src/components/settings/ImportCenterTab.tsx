import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  FileSpreadsheet,
  GitBranch,
  Github,
  RefreshCw,
  Upload,
  XCircle,
  Zap,
} from 'lucide-react';
import { Spinner, cn } from '@nockta/ui';
import { api } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { AdminGate, SectionTitle, apiErrorMessage } from './primitives';

// =============================================================================
// ImportCenterTab — admin-only multi-source import wizard.
//
// Four source tabs share the same shape: paste credentials → list source
// projects → pick one → preview the first 20 rows → commit. Progress streams
// over Socket.IO room `import:<runId>` so the UI advances row-by-row. Below
// the tabs an ImportRunsTable shows the last 20 runs and offers a "re-run"
// affordance that re-opens the source tab with the prior mapping pre-filled.
//
// API key / token entry is NEVER persisted — credentials live in component
// state for the duration of the wizard.
// =============================================================================

type ImportTabKey = 'csv' | 'linear' | 'github' | 'jira' | 'jira-csv';

interface ImportRunSummary {
  id: string;
  source: 'csv' | 'linear' | 'jira' | 'github_issues';
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  sourceRef: string | null;
  totalRows: number;
  createdRows: number;
  skippedRows: number;
  erroredRows: number;
  startedAt: string;
  finishedAt: string | null;
  errorSummary: string | null;
  /** Pass D — set when a run failed mid-stream; the runs table renders a
   *  "Resume" button that re-plays from `resumableFromRow + 1` via
   *  POST /import/:id/resume. */
  resumableFromRow?: number | null;
  lastError?: string | null;
  mappingSnapshot?: unknown;
  actor?: { id: string; name: string; email: string } | null;
  project?: { id: string; key: string; name: string } | null;
}

/** Field descriptor as returned by GET /import/source-fields?source=… */
interface ImportSourceFieldPayload {
  sourceKey: string;
  label: string;
  requiredFor: 'always' | 'optional';
  defaultTargetField?: string;
  description?: string;
  sample?: string;
}

/** Normalized response from POST /import/dry-run — the mapper UI's Step 3. */
interface DryRunResponsePayload {
  preview: Array<{
    row: number;
    fields: Record<string, unknown>;
    validationErrors: string[];
  }>;
  wouldInsert: number;
  wouldSkip: number;
}

export function ImportCenterTab({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ImportTabKey>('csv');
  /** When set, opens the corresponding source tab with a mapping snapshot
   *  pre-filled. Sourced from the runs table's "re-run" button. */
  const [rerunSnapshot, setRerunSnapshot] = useState<{
    tab: ImportTabKey;
    snapshot: unknown;
  } | null>(null);

  if (!isAdmin) return <AdminGate />;

  const tabs: { key: ImportTabKey; label: string; icon: JSX.Element }[] = [
    { key: 'csv', label: 'CSV', icon: <FileSpreadsheet className="h-3.5 w-3.5" /> },
    { key: 'linear', label: 'Linear', icon: <Zap className="h-3.5 w-3.5" /> },
    { key: 'github', label: 'GitHub Issues', icon: <Github className="h-3.5 w-3.5" /> },
    { key: 'jira', label: 'Jira (API)', icon: <GitBranch className="h-3.5 w-3.5" /> },
    { key: 'jira-csv', label: 'Jira (CSV)', icon: <FileSpreadsheet className="h-3.5 w-3.5" /> },
  ];

  const handleRerun = (run: ImportRunSummary): void => {
    const sourceToTab: Record<ImportRunSummary['source'], ImportTabKey> = {
      csv: 'csv',
      linear: 'linear',
      github_issues: 'github',
      jira: 'jira',
    };
    const target = sourceToTab[run.source];
    setTab(target);
    setRerunSnapshot({ tab: target, snapshot: run.mappingSnapshot });
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-5xl space-y-6 sm:space-y-8">
      <SectionTitle
        title={t('settings.imports.title', 'Import center')}
        hint={t(
          'settings.imports.hint',
          'Bring existing tasks in from CSV, Linear, GitHub Issues, or Jira. Per-row progress streams live; runs are tracked below.',
        )}
      />

      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'csv' && <CsvImporter />}
      {tab === 'linear' && (
        <LinearImporter
          rerunSnapshot={rerunSnapshot?.tab === 'linear' ? rerunSnapshot.snapshot : null}
        />
      )}
      {tab === 'github' && (
        <GitHubIssuesImporter
          rerunSnapshot={rerunSnapshot?.tab === 'github' ? rerunSnapshot.snapshot : null}
        />
      )}
      {tab === 'jira' && (
        <JiraImporter
          rerunSnapshot={rerunSnapshot?.tab === 'jira' ? rerunSnapshot.snapshot : null}
        />
      )}
      {tab === 'jira-csv' && <JiraCsvImporter />}

      <ImportRunsTable onRerun={handleRerun} />
    </div>
  );
}

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

/**
 * Subscribe to `import:<runId>` and surface processed/total + done status.
 * Cleans up its listeners on unmount or runId change.
 */
function useImportProgress(runId: string | null): {
  processed: number;
  total: number;
  done: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  errorSummary: string | null;
} {
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState<'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'>(
    'idle',
  );
  const [errorSummary, setErrorSummary] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) {
      setProcessed(0);
      setTotal(0);
      setDone('idle');
      setErrorSummary(null);
      return;
    }
    setDone('running');
    setErrorSummary(null);
    const socket = getSocket();
    const onProgress = (payload: { runId: string; processed: number; total: number }): void => {
      if (payload.runId !== runId) return;
      setProcessed(payload.processed);
      setTotal(payload.total);
    };
    const onDone = (payload: {
      runId: string;
      processed: number;
      total: number;
      status: 'succeeded' | 'failed' | 'cancelled';
      errorSummary?: string;
    }): void => {
      if (payload.runId !== runId) return;
      setProcessed(payload.processed);
      setTotal(payload.total);
      setDone(payload.status);
      setErrorSummary(payload.errorSummary ?? null);
    };
    socket.emit('import:join', { runId });
    socket.on('import.progress', onProgress);
    socket.on('import.done', onDone);
    return () => {
      socket.off('import.progress', onProgress);
      socket.off('import.done', onDone);
      socket.emit('import:leave', { runId });
    };
  }, [runId]);

  return { processed, total, done, errorSummary };
}

function ImportProgressBar({
  processed,
  total,
  done,
}: {
  processed: number;
  total: number;
  done: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}): JSX.Element {
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const tone =
    done === 'succeeded'
      ? 'bg-status-done'
      : done === 'failed' || done === 'cancelled'
        ? 'bg-status-blocked'
        : 'bg-primary';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] tabular-nums">
        <span className="text-muted-foreground">
          {done === 'running' && 'Importing…'}
          {done === 'succeeded' && 'Imported'}
          {done === 'failed' && 'Failed'}
          {done === 'cancelled' && 'Cancelled'}
          {done === 'idle' && 'Waiting'}
        </span>
        <span className="text-muted-foreground">
          {processed} / {total || '?'} ({pct}%)
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-border/60 overflow-hidden">
        <div
          className={cn('h-full transition-all duration-200', tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function CsvImporter(): JSX.Element {
  const projectsQuery = useQuery({
    queryKey: ['projects'],
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

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'primary' | 'danger' | undefined;
}): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-md border p-3 text-center',
        tone === 'primary' && 'border-primary/40 bg-primary/10',
        tone === 'danger' && 'border-status-blocked/40 bg-status-blocked/10',
        !tone && 'border-border bg-card/30',
      )}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums mt-1">{value}</div>
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

// =============================================================================
// Linear importer — paste API key → list teams → pick team → preview → run.
// =============================================================================

interface LinearTeamPayload {
  id: string;
  key: string;
  name: string;
  description?: string | null;
}

interface LinearPreviewPayload {
  totalIssues: number;
  preview: Array<{
    identifier: string;
    title: string;
    status: string;
    priority: string;
    type: string;
    assigneeEmail: string | null;
    labels: string[];
    dueDate: string | null;
  }>;
}

function LinearImporter({ rerunSnapshot }: { rerunSnapshot?: unknown }): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [teamId, setTeamId] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [statusOverrides, setStatusOverrides] = useState<Record<string, string>>({});
  const [step, setStep] = useState<'creds' | 'pick' | 'preview' | 'running' | 'done'>('creds');
  const [preview, setPreview] = useState<LinearPreviewPayload | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const progress = useImportProgress(activeRunId);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!rerunSnapshot || typeof rerunSnapshot !== 'object') return;
    const s = rerunSnapshot as {
      teamId?: string;
      teamKey?: string;
      mapping?: { includeArchived?: boolean; statusByType?: Record<string, string> };
    };
    if (s.teamId) setTeamId(s.teamId);
    if (s.mapping?.includeArchived) setIncludeArchived(true);
    if (s.mapping?.statusByType) setStatusOverrides(s.mapping.statusByType);
  }, [rerunSnapshot]);

  const teamsMutation = useMutation({
    mutationFn: () => api.post<LinearTeamPayload[]>('/import/linear/teams', { apiKey }),
    onSuccess: () => setStep('pick'),
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not reach Linear')),
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      api.post<LinearPreviewPayload>('/import/linear/preview', {
        apiKey,
        teamId,
        mapping: { includeArchived, statusByType: statusOverrides },
      }),
    onSuccess: (resp) => {
      setPreview(resp);
      setStep('preview');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Preview failed')),
  });

  const runMutation = useMutation({
    mutationFn: () =>
      api.post<{ runId: string }>('/import/linear/run', {
        apiKey,
        teamId,
        mapping: { includeArchived, statusByType: statusOverrides },
      }),
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
        toast.success(`Imported ${progress.processed} of ${progress.total} issues`);
      } else {
        toast.error('Import failed — check the runs table for details');
      }
      setStep('done');
    }
  }, [progress.done, progress.processed, progress.total, queryClient]);

  const teams = teamsMutation.data ?? [];
  const selectedTeam = teams.find((t) => t.id === teamId);

  return (
    <div className="rounded-lg border border-border bg-card/40 p-5 space-y-5">
      <SourceHeader
        icon={<Zap className="h-5 w-5" />}
        title="Linear import"
        subtitle={
          selectedTeam
            ? `${selectedTeam.key} · ${selectedTeam.name}`
            : 'Paste your Linear personal API key (Settings → API)'
        }
      />

      {step === 'creds' && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-muted-foreground block mb-1">Linear API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="lin_api_…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => teamsMutation.mutate()}
              disabled={!apiKey || teamsMutation.isPending}
              className="rounded-md bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
            >
              {teamsMutation.isPending ? 'Connecting…' : 'List teams'}
            </button>
          </div>
        </div>
      )}

      {step === 'pick' && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-muted-foreground block mb-1">Pick a team</span>
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Select…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.key} · {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="rounded border-input"
            />
            Also pull archived issues
          </label>
          <details className="rounded-md border border-border bg-background/40">
            <summary className="px-3 py-2 text-xs font-medium cursor-pointer">
              Status mapping (optional)
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-2">
              {(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'] as const).map(
                (k) => (
                  <div key={k} className="grid grid-cols-2 gap-2 items-center text-xs">
                    <span className="font-mono text-muted-foreground">{k}</span>
                    <input
                      type="text"
                      placeholder="(default)"
                      value={statusOverrides[k] ?? ''}
                      onChange={(e) =>
                        setStatusOverrides((m) => ({ ...m, [k]: e.target.value }))
                      }
                      className="rounded-md border border-input bg-background px-2 py-1"
                    />
                  </div>
                ),
              )}
            </div>
          </details>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('creds')}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent transition"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => previewMutation.mutate()}
              disabled={!teamId || previewMutation.isPending}
              className="rounded-md bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
            >
              {previewMutation.isPending ? 'Loading…' : 'Preview import'}
            </button>
          </div>
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Issues" value={preview.totalIssues} />
            <Stat label="Preview rows" value={preview.preview.length} tone="primary" />
          </div>
          <div className="rounded-md border border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-secondary/40">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium">Key</th>
                  <th className="text-left px-2 py-1.5 font-medium">Title</th>
                  <th className="text-left px-2 py-1.5 font-medium">Status</th>
                  <th className="text-left px-2 py-1.5 font-medium">Type</th>
                  <th className="text-left px-2 py-1.5 font-medium">Assignee</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((r) => (
                  <tr key={r.identifier} className="border-t border-border">
                    <td className="px-2 py-1.5 font-mono">{r.identifier}</td>
                    <td className="px-2 py-1.5 truncate max-w-[280px]">{r.title}</td>
                    <td className="px-2 py-1.5">{r.status}</td>
                    <td className="px-2 py-1.5">{r.type}</td>
                    <td className="px-2 py-1.5 text-muted-foreground truncate max-w-[180px]">
                      {r.assigneeEmail ?? <span className="opacity-50">(unassigned)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('pick')}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent transition"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
              className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
            >
              {runMutation.isPending ? 'Starting…' : `Import ${preview.totalIssues} issues`}
            </button>
          </div>
        </div>
      )}

      {step === 'running' && (
        <ImportProgressBar
          processed={progress.processed}
          total={progress.total}
          done={progress.done}
        />
      )}

      {step === 'done' && (
        <div className="rounded-md border border-status-done/40 bg-status-done/10 p-4 space-y-2">
          <p className="text-sm font-semibold">Done — see runs table below.</p>
          <button
            type="button"
            onClick={() => {
              setStep('creds');
              setActiveRunId(null);
              setPreview(null);
              setTeamId('');
            }}
            className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
          >
            Import another team
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Jira importer — paste credentials → list projects → pick project → preview → run.
// =============================================================================

interface JiraProjectPayload {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
}

interface JiraPreviewPayload {
  totalIssues: number;
  preview: Array<{
    key: string;
    title: string;
    status: string;
    priority: string;
    type: string;
    assigneeEmail: string | null;
    labels: string[];
    dueDate: string | null;
  }>;
}

function JiraImporter({ rerunSnapshot }: { rerunSnapshot?: unknown }): JSX.Element {
  const [domain, setDomain] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [step, setStep] = useState<'creds' | 'pick' | 'preview' | 'running' | 'done'>('creds');
  const [preview, setPreview] = useState<JiraPreviewPayload | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const progress = useImportProgress(activeRunId);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!rerunSnapshot || typeof rerunSnapshot !== 'object') return;
    const s = rerunSnapshot as { projectKey?: string };
    if (s.projectKey) setProjectKey(s.projectKey);
  }, [rerunSnapshot]);

  const projectsMutation = useMutation({
    mutationFn: () =>
      api.post<JiraProjectPayload[]>('/import/jira/projects', { domain, email, apiToken }),
    onSuccess: () => setStep('pick'),
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not reach Jira')),
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      api.post<JiraPreviewPayload>('/import/jira/preview', {
        domain,
        email,
        apiToken,
        projectKey,
        mapping: {},
      }),
    onSuccess: (resp) => {
      setPreview(resp);
      setStep('preview');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Preview failed')),
  });

  const runMutation = useMutation({
    mutationFn: () =>
      api.post<{ runId: string }>('/import/jira/run', {
        domain,
        email,
        apiToken,
        projectKey,
        mapping: {},
      }),
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
        toast.success(`Imported ${progress.processed} of ${progress.total} issues`);
      } else {
        toast.error('Import failed — check the runs table for details');
      }
      setStep('done');
    }
  }, [progress.done, progress.processed, progress.total, queryClient]);

  const projects = projectsMutation.data ?? [];

  return (
    <div className="rounded-lg border border-border bg-card/40 p-5 space-y-5">
      <SourceHeader
        icon={<GitBranch className="h-5 w-5" />}
        title="Jira import"
        subtitle="Paste your Jira Cloud credentials. Worklogs and comments are imported via the CLI only (see import:jira)."
      />

      {step === 'creds' && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-muted-foreground block mb-1">Domain</span>
            <input
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="acme.atlassian.net"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground block mb-1">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground block mb-1">
              API token (create at id.atlassian.com → Security → API tokens)
            </span>
            <input
              type="password"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => projectsMutation.mutate()}
              disabled={!domain || !email || !apiToken || projectsMutation.isPending}
              className="rounded-md bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
            >
              {projectsMutation.isPending ? 'Connecting…' : 'List projects'}
            </button>
          </div>
        </div>
      )}

      {step === 'pick' && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-muted-foreground block mb-1">Pick a project</span>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Select…</option>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key} · {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('creds')}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent transition"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => previewMutation.mutate()}
              disabled={!projectKey || previewMutation.isPending}
              className="rounded-md bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
            >
              {previewMutation.isPending ? 'Loading…' : 'Preview import'}
            </button>
          </div>
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Issues" value={preview.totalIssues} />
            <Stat label="Preview rows" value={preview.preview.length} tone="primary" />
          </div>
          <div className="rounded-md border border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-secondary/40">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium">Key</th>
                  <th className="text-left px-2 py-1.5 font-medium">Title</th>
                  <th className="text-left px-2 py-1.5 font-medium">Status</th>
                  <th className="text-left px-2 py-1.5 font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((r) => (
                  <tr key={r.key} className="border-t border-border">
                    <td className="px-2 py-1.5 font-mono">{r.key}</td>
                    <td className="px-2 py-1.5 truncate max-w-[280px]">{r.title}</td>
                    <td className="px-2 py-1.5">{r.status}</td>
                    <td className="px-2 py-1.5">{r.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('pick')}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent transition"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
              className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
            >
              {runMutation.isPending ? 'Starting…' : `Import ${preview.totalIssues} issues`}
            </button>
          </div>
        </div>
      )}

      {step === 'running' && (
        <ImportProgressBar
          processed={progress.processed}
          total={progress.total}
          done={progress.done}
        />
      )}

      {step === 'done' && (
        <div className="rounded-md border border-status-done/40 bg-status-done/10 p-4 space-y-2">
          <p className="text-sm font-semibold">Done — see runs table below.</p>
          <button
            type="button"
            onClick={() => {
              setStep('creds');
              setActiveRunId(null);
              setPreview(null);
              setProjectKey('');
            }}
            className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
          >
            Import another project
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// GitHub Issues importer — pick installation → pick repo → pick destination
// project → preview → run. Reuses the existing GitHub App installation flow.
// =============================================================================

interface GhRepoPayload {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  private: boolean;
}

interface GhPreviewPayload {
  totalIssues: number;
  preview: Array<{
    number: number;
    title: string;
    status: string;
    type: string;
    assigneeLogin: string | null;
    labels: string[];
  }>;
}

function GitHubIssuesImporter({ rerunSnapshot }: { rerunSnapshot?: unknown }): JSX.Element {
  const [installationId, setInstallationId] = useState('');
  const [ownerRepo, setOwnerRepo] = useState('');
  const [projectId, setProjectId] = useState('');
  const [includeClosed, setIncludeClosed] = useState(true);
  const [step, setStep] = useState<'creds' | 'pick' | 'preview' | 'running' | 'done'>('creds');
  const [preview, setPreview] = useState<GhPreviewPayload | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const progress = useImportProgress(activeRunId);
  const queryClient = useQueryClient();

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Array<{ id: string; key: string; name: string }>>('/projects'),
  });
  const projects = projectsQuery.data ?? [];

  useEffect(() => {
    if (!rerunSnapshot || typeof rerunSnapshot !== 'object') return;
    const s = rerunSnapshot as { owner?: string; repo?: string };
    if (s.owner && s.repo) setOwnerRepo(`${s.owner}/${s.repo}`);
  }, [rerunSnapshot]);

  const reposMutation = useMutation({
    mutationFn: () =>
      api.post<GhRepoPayload[]>('/import/github-issues/repos', {
        installationId: Number(installationId),
      }),
    onSuccess: () => setStep('pick'),
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not reach GitHub')),
  });

  const previewMutation = useMutation({
    mutationFn: () => {
      const [owner, repo] = ownerRepo.split('/');
      return api.post<GhPreviewPayload>('/import/github-issues/preview', {
        installationId: Number(installationId),
        owner,
        repo,
        mapping: { includeClosed },
      });
    },
    onSuccess: (resp) => {
      setPreview(resp);
      setStep('preview');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Preview failed')),
  });

  const runMutation = useMutation({
    mutationFn: () => {
      const [owner, repo] = ownerRepo.split('/');
      return api.post<{ runId: string }>('/import/github-issues/run', {
        installationId: Number(installationId),
        owner,
        repo,
        projectId,
        mapping: { includeClosed },
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
        toast.success(`Imported ${progress.processed} of ${progress.total} issues`);
      } else {
        toast.error('Import failed — check the runs table for details');
      }
      setStep('done');
    }
  }, [progress.done, progress.processed, progress.total, queryClient]);

  const repos = reposMutation.data ?? [];

  return (
    <div className="rounded-lg border border-border bg-card/40 p-5 space-y-5">
      <SourceHeader
        icon={<Github className="h-5 w-5" />}
        title="GitHub Issues import"
        subtitle="Bring issues from a GitHub repo into an existing Nockta project. Pull requests are skipped."
      />

      {step === 'creds' && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-muted-foreground block mb-1">
              Installation ID (Settings → Integrations → GitHub → copy from the linked installation)
            </span>
            <input
              type="number"
              value={installationId}
              onChange={(e) => setInstallationId(e.target.value)}
              placeholder="123456"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => reposMutation.mutate()}
              disabled={!installationId || reposMutation.isPending}
              className="rounded-md bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
            >
              {reposMutation.isPending ? 'Connecting…' : 'List repos'}
            </button>
          </div>
        </div>
      )}

      {step === 'pick' && (
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-muted-foreground block mb-1">Repository</span>
            <select
              value={ownerRepo}
              onChange={(e) => setOwnerRepo(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Select…</option>
              {repos.map((r) => (
                <option key={r.id} value={r.full_name}>
                  {r.full_name}
                  {r.private ? ' (private)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground block mb-1">Destination project</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Select…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.key} · {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(e) => setIncludeClosed(e.target.checked)}
              className="rounded border-input"
            />
            Include closed issues
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('creds')}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent transition"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => previewMutation.mutate()}
              disabled={!ownerRepo || !projectId || previewMutation.isPending}
              className="rounded-md bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
            >
              {previewMutation.isPending ? 'Loading…' : 'Preview import'}
            </button>
          </div>
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Issues (first page)" value={preview.totalIssues} />
            <Stat label="Preview rows" value={preview.preview.length} tone="primary" />
          </div>
          <div className="rounded-md border border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-secondary/40">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium">#</th>
                  <th className="text-left px-2 py-1.5 font-medium">Title</th>
                  <th className="text-left px-2 py-1.5 font-medium">Status</th>
                  <th className="text-left px-2 py-1.5 font-medium">Assignee</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((r) => (
                  <tr key={r.number} className="border-t border-border">
                    <td className="px-2 py-1.5 font-mono">#{r.number}</td>
                    <td className="px-2 py-1.5 truncate max-w-[320px]">{r.title}</td>
                    <td className="px-2 py-1.5">{r.status}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {r.assigneeLogin ?? <span className="opacity-50">(unassigned)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('pick')}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent transition"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
              className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition"
            >
              {runMutation.isPending ? 'Starting…' : 'Import all issues'}
            </button>
          </div>
        </div>
      )}

      {step === 'running' && (
        <ImportProgressBar
          processed={progress.processed}
          total={progress.total}
          done={progress.done}
        />
      )}

      {step === 'done' && (
        <div className="rounded-md border border-status-done/40 bg-status-done/10 p-4 space-y-2">
          <p className="text-sm font-semibold">Done — see runs table below.</p>
          <button
            type="button"
            onClick={() => {
              setStep('creds');
              setActiveRunId(null);
              setPreview(null);
              setOwnerRepo('');
            }}
            className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
          >
            Import another repo
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// ImportRunsTable — last 20 runs, sortable by start time, with a re-run button.
// =============================================================================

function ImportRunsTable({
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

function StatusBadge({ status }: { status: ImportRunSummary['status'] }): JSX.Element {
  if (status === 'succeeded') {
    return (
      <span className="inline-flex items-center gap-1 text-status-done">
        <CheckCircle2 className="h-3 w-3" />
        Succeeded
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-status-blocked">
        <XCircle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-primary">
        <Spinner className="h-3 w-3" />
        Running
      </span>
    );
  }
  return <span className="text-muted-foreground capitalize">{status}</span>;
}

function SourceHeader({
  icon,
  title,
  subtitle,
}: {
  icon: JSX.Element;
  title: string;
  subtitle: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <div className="h-10 w-10 rounded-md bg-brand/10 text-brand flex items-center justify-center">
        {icon}
      </div>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

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

function JiraCsvImporter(): JSX.Element {
  const projectsQuery = useQuery({
    queryKey: ['projects'],
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
