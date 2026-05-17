import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';
import { api } from '../../lib/api';
import { AdminGate, Field, Fieldset, SectionTitle, apiErrorMessage } from './primitives';

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

type ExportKind = 'csv' | 'xlsx' | 'pdf';
type SourceKind = 'saved_view' | 'project' | 'all_tasks';
type DeliveryKind = 'download' | 'email';
type RunStatus = 'queued' | 'running' | 'completed' | 'failed';

interface ExportSchedule {
  id: string;
  workspaceId: string;
  name: string;
  kind: ExportKind;
  sourceKind: SourceKind;
  sourceId: string | null;
  scheduleCron: string | null;
  deliveryKind: DeliveryKind;
  deliveryEmail: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

interface ExportRun {
  id: string;
  scheduleId: string | null;
  kind: ExportKind;
  sourceKind: SourceKind | null;
  sourceId: string | null;
  status: RunStatus;
  signedUrl: string | null;
  expiresAt: string | null;
  fileSize: number;
  rowCount: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface SavedViewOption {
  id: string;
  name: string;
}
interface ProjectOption {
  id: string;
  key: string;
  name: string;
}

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

// =============================================================================
// Schedules table
// =============================================================================

function SchedulesTable({
  schedules,
  onToggle,
  onDelete,
  onRun,
}: {
  schedules: ExportSchedule[];
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string, name: string) => void;
  onRun: (id: string) => void;
}): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-background/40 text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Name</th>
            <th className="text-left px-3 py-2 font-medium">Kind</th>
            <th className="text-left px-3 py-2 font-medium">Source</th>
            <th className="text-left px-3 py-2 font-medium">Schedule</th>
            <th className="text-left px-3 py-2 font-medium">Last run</th>
            <th className="text-left px-3 py-2 font-medium">Status</th>
            <th className="text-right px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => (
            <tr key={s.id} className="border-t border-border/60">
              <td className="px-3 py-2 font-medium">{s.name}</td>
              <td className="px-3 py-2 uppercase tracking-wider text-[10px]">{s.kind}</td>
              <td className="px-3 py-2">
                <SourceLabel sourceKind={s.sourceKind} sourceId={s.sourceId} />
              </td>
              <td className="px-3 py-2 font-mono text-[11px]">
                {s.scheduleCron ?? <span className="text-muted-foreground italic">one-off</span>}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '—'}
              </td>
              <td className="px-3 py-2">
                <span
                  className={cn(
                    'text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5',
                    s.enabled
                      ? 'bg-status-done/15 text-status-done'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {s.enabled ? 'enabled' : 'disabled'}
                </span>
              </td>
              <td className="px-3 py-2 text-right space-x-1">
                <button
                  type="button"
                  onClick={() => onRun(s.id)}
                  className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-accent/40 transition-colors"
                >
                  Run now
                </button>
                <button
                  type="button"
                  onClick={() => onToggle(s.id, !s.enabled)}
                  className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-accent/40 transition-colors"
                >
                  {s.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(s.id, s.name)}
                  className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceLabel({
  sourceKind,
  sourceId,
}: {
  sourceKind: SourceKind;
  sourceId: string | null;
}): JSX.Element {
  if (sourceKind === 'all_tasks') return <span className="text-muted-foreground">All tasks</span>;
  if (sourceKind === 'saved_view')
    return (
      <span>
        Saved view <code className="font-mono text-[10px] text-muted-foreground">{sourceId?.slice(0, 8)}</code>
      </span>
    );
  return (
    <span>
      Project <code className="font-mono text-[10px] text-muted-foreground">{sourceId?.slice(0, 8)}</code>
    </span>
  );
}

// =============================================================================
// Recent runs subview
// =============================================================================

function RecentRunsSubview(): JSX.Element {
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

// =============================================================================
// Create form
// =============================================================================

const SCHEDULE_PRESETS: Array<{ label: string; cron: string | null }> = [
  { label: 'One-off (run now)', cron: null },
  { label: 'Daily at 09:00 UTC', cron: '0 9 * * *' },
  { label: 'Weekly Mon 09:00 UTC', cron: '0 9 * * 1' },
  { label: 'Custom cron…', cron: '__custom__' as unknown as string },
];

function CreateExportForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ExportKind>('csv');
  const [sourceKind, setSourceKind] = useState<SourceKind>('all_tasks');
  const [sourceId, setSourceId] = useState<string>('');
  const [preset, setPreset] = useState<string>(SCHEDULE_PRESETS[0]!.label);
  const [customCron, setCustomCron] = useState<string>('');
  const [deliveryKind, setDeliveryKind] = useState<DeliveryKind>('download');
  const [deliveryEmail, setDeliveryEmail] = useState<string>('');

  const projectsQuery = useQuery({
    queryKey: ['projects-for-exports'],
    queryFn: () => api.get<ProjectOption[]>('/projects'),
    enabled: sourceKind === 'project',
  });
  const savedViewsQuery = useQuery({
    queryKey: ['saved-views-for-exports'],
    queryFn: () => api.get<SavedViewOption[]>('/saved-views'),
    enabled: sourceKind === 'saved_view',
  });

  const create = useMutation({
    mutationFn: (input: {
      name: string;
      kind: ExportKind;
      sourceKind: SourceKind;
      sourceId?: string;
      scheduleCron: string | null;
      deliveryKind: DeliveryKind;
      deliveryEmail?: string;
    }) => api.post<ExportSchedule>(`/exports/schedules`, input),
    onSuccess: () => {
      toast.success('Export scheduled');
      onCreated();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not create export')),
  });

  const presetCron = SCHEDULE_PRESETS.find((p) => p.label === preset)?.cron ?? null;
  const isCustom = presetCron === '__custom__';
  const effectiveCron = isCustom ? customCron.trim() || null : presetCron;

  return (
    <Fieldset legend="New export" hint="Pick the source, the file kind, and the cadence.">
      <Field label="Name" htmlFor="ex-name">
        <input
          id="ex-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Weekly engineering roster"
          className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3 mt-3">
        <Field label="File kind" htmlFor="ex-kind">
          <select
            id="ex-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ExportKind)}
            className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
          >
            <option value="csv">CSV</option>
            <option value="xlsx">XLSX (Excel)</option>
            <option value="pdf">PDF</option>
          </select>
        </Field>
        <Field label="Source" htmlFor="ex-source-kind">
          <select
            id="ex-source-kind"
            value={sourceKind}
            onChange={(e) => {
              setSourceKind(e.target.value as SourceKind);
              setSourceId('');
            }}
            className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
          >
            <option value="all_tasks">All tasks</option>
            <option value="project">A single project</option>
            <option value="saved_view">A saved view</option>
          </select>
        </Field>
      </div>

      {sourceKind === 'project' && (
        <Field label="Project" htmlFor="ex-project">
          <select
            id="ex-project"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
          >
            <option value="">— pick a project —</option>
            {projectsQuery.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} — {p.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {sourceKind === 'saved_view' && (
        <Field label="Saved view" htmlFor="ex-saved-view">
          <select
            id="ex-saved-view"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
          >
            <option value="">— pick a saved view —</option>
            {savedViewsQuery.data?.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Schedule" htmlFor="ex-preset" hint="Cron expressions are evaluated in UTC.">
        <select
          id="ex-preset"
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
        >
          {SCHEDULE_PRESETS.map((p) => (
            <option key={p.label} value={p.label}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      {isCustom && (
        <Field
          label="Custom cron expression"
          htmlFor="ex-cron"
          hint="5-field standard syntax (minute hour dom month dow). Example: 0 9 * * 1 — every Monday at 09:00 UTC."
        >
          <input
            id="ex-cron"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder="0 9 * * 1"
            className={cn(
              'w-full rounded-md border border-border bg-background/60 px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-brand',
              customCron.trim() && !isLikelyValidCron(customCron) && 'border-destructive/60',
            )}
          />
          {customCron.trim() && !isLikelyValidCron(customCron) && (
            <div className="text-[10px] text-destructive mt-1">
              Cron must have exactly 5 fields. Try “0 9 * * 1”.
            </div>
          )}
        </Field>
      )}

      <Field label="Delivery" htmlFor="ex-delivery">
        <select
          id="ex-delivery"
          value={deliveryKind}
          onChange={(e) => setDeliveryKind(e.target.value as DeliveryKind)}
          className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
        >
          <option value="download">Download link only</option>
          <option value="email">Email the link to a recipient</option>
        </select>
      </Field>

      {deliveryKind === 'email' && (
        <Field label="Recipient email" htmlFor="ex-email">
          <input
            id="ex-email"
            type="email"
            value={deliveryEmail}
            onChange={(e) => setDeliveryEmail(e.target.value)}
            placeholder="exports@your-company.com"
            className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
          />
        </Field>
      )}

      <div className="flex justify-end gap-2 pt-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent/40 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            if (!name.trim()) {
              toast.error('Name is required');
              return;
            }
            if ((sourceKind === 'project' || sourceKind === 'saved_view') && !sourceId) {
              toast.error('Pick the source row');
              return;
            }
            if (isCustom && !isLikelyValidCron(customCron)) {
              toast.error('Cron expression looks invalid');
              return;
            }
            if (deliveryKind === 'email' && !deliveryEmail.trim()) {
              toast.error('Recipient email is required for email delivery');
              return;
            }
            create.mutate({
              name: name.trim(),
              kind,
              sourceKind,
              ...(sourceId ? { sourceId } : {}),
              scheduleCron: effectiveCron,
              deliveryKind,
              ...(deliveryKind === 'email' ? { deliveryEmail: deliveryEmail.trim() } : {}),
            });
          }}
          disabled={create.isPending}
          className="rounded-md border border-border bg-brand text-brand-foreground px-3 py-1.5 text-xs font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create export'}
        </button>
      </div>
    </Fieldset>
  );
}

// =============================================================================
// Client-side cron sanity check. Doesn't replicate the server's full grammar
// (the API will reject anything more exotic), just catches the common typos.
// =============================================================================
function isLikelyValidCron(s: string): boolean {
  const parts = s.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  return parts.every((part, i) => isValidCronField(part, ranges[i]![0], ranges[i]![1]));
}

function isValidCronField(field: string, lo: number, hi: number): boolean {
  if (field === '*') return true;
  for (const segment of field.split(',')) {
    let range = segment;
    if (segment.includes('/')) {
      const [r, step] = segment.split('/');
      range = r ?? '*';
      if (!/^\d+$/.test(step ?? '')) return false;
    }
    if (range === '*') continue;
    if (range.includes('-')) {
      const [a, b] = range.split('-');
      const na = Number(a);
      const nb = Number(b);
      if (!Number.isInteger(na) || !Number.isInteger(nb)) return false;
      if (na < lo || nb > hi || na > nb) return false;
    } else {
      const n = Number(range);
      if (!Number.isInteger(n) || n < lo || n > hi) return false;
    }
  }
  return true;
}
