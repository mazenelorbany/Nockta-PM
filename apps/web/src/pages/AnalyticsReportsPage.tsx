import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { cn, QueryErrorState, Skeleton } from '@nockta/ui';

import { api } from '../lib/api';

// =============================================================================
// AnalyticsReportsPage — Pass I (Analytics 8 → 9). Custom report builder.
//
// A user picks one or more dimensions, a single metric, and a filter set.
// The "Preview" button hits /analytics/reports/preview to render the chart
// inline before saving. Save persists the definition via POST
// /analytics/reports; the report then shows up in the list and can be
// re-run with GET /analytics/reports/:id/run.
//
// Charting model: the result rows are bucketed into bars on the X-axis using
// the FIRST dimension. Additional dimensions produce stacked / grouped bars
// — we use a simple grouped pattern keyed by the second dimension and color
// each group with a stable palette so re-runs look the same.
// =============================================================================

const DIMENSIONS = ['status', 'priority', 'assignee', 'sprint', 'label', 'project'] as const;
const METRICS = ['count', 'sum_estimate', 'sum_actual'] as const;
type Dimension = (typeof DIMENSIONS)[number];
type Metric = (typeof METRICS)[number];

const PALETTE = [
  'hsl(var(--brand))',
  'hsl(var(--priority-high))',
  'hsl(var(--priority-medium))',
  'hsl(var(--status-done))',
  'hsl(var(--status-blocked))',
  'hsl(var(--priority-low))',
];

interface CustomReport {
  id: string;
  name: string;
  dimensions: Dimension[];
  metric: Metric;
  filters: Record<string, unknown>;
  projectId: string | null;
  createdAt: string;
  createdBy: { id: string; name: string; avatarUrl: string | null } | null;
}

interface ReportResult {
  dimensions: Dimension[];
  metric: Metric;
  rows: Array<{ dimensionValues: Record<string, string | null>; metricValue: number }>;
}

export function AnalyticsReportsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const reportsQuery = useQuery({
    queryKey: ['custom-reports'],
    queryFn: () => api.get<CustomReport[]>('/analytics/reports'),
  });

  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/analytics/reports/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['custom-reports'] });
      setSelectedId(null);
      toast.success('Report deleted');
    },
  });

  if (reportsQuery.isError) {
    return (
      <QueryErrorState
        title="Couldn't load reports"
        error={reportsQuery.error}
        onRetry={() => void reportsQuery.refetch()}
      />
    );
  }

  const reports = reportsQuery.data ?? [];

  return (
    <div className="flex flex-col md:flex-row gap-4 md:gap-6">
      {/* Sidebar — saved reports list */}
      <aside className="md:w-72 shrink-0 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs nockta-eyebrow text-muted-foreground">Saved reports</h3>
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="inline-block h-3 w-3 mr-1" /> New report
          </button>
        </div>
        {reports.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-card/30 p-4 text-xs text-muted-foreground">
            No saved reports yet. Click "New report" to build one.
          </div>
        ) : (
          <ul className="rounded-md border border-border bg-card divide-y divide-border overflow-hidden">
            {reports.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={cn(
                    'w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors',
                    selectedId === r.id && 'bg-accent/60',
                  )}
                >
                  <div className="font-medium truncate">{r.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {r.metric} by {r.dimensions.join(', ')}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Main panel — selected report or empty state */}
      <main className="flex-1 min-w-0">
        {selectedId ? (
          <RunReportPanel
            reportId={selectedId}
            report={reports.find((r) => r.id === selectedId) ?? null}
            onDelete={() => removeMutation.mutate(selectedId)}
          />
        ) : (
          <div className="rounded-md border border-dashed border-border bg-card/30 p-10 text-sm text-muted-foreground text-center">
            Pick a report on the left, or click "New report" to build one.
          </div>
        )}
      </main>

      {editorOpen && (
        <ReportEditorModal
          onClose={() => setEditorOpen(false)}
          onSaved={(id) => {
            setEditorOpen(false);
            setSelectedId(id);
            void queryClient.invalidateQueries({ queryKey: ['custom-reports'] });
          }}
        />
      )}
    </div>
  );
}

function RunReportPanel({
  reportId,
  report,
  onDelete,
}: {
  reportId: string;
  report: CustomReport | null;
  onDelete: () => void;
}): JSX.Element {
  const runQuery = useQuery({
    queryKey: ['custom-report-run', reportId],
    queryFn: () => api.get<ReportResult>(`/analytics/reports/${reportId}/run`),
  });

  if (runQuery.isLoading || !runQuery.data) return <Skeleton className="h-80 w-full" />;
  if (runQuery.isError) {
    return (
      <QueryErrorState
        title="Couldn't run the report"
        error={runQuery.error}
        onRetry={() => void runQuery.refetch()}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{report?.name ?? 'Report'}</h2>
          <p className="text-xs text-muted-foreground">
            {runQuery.data.metric} by {runQuery.data.dimensions.join(', ')}
          </p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-status-blocked hover:border-status-blocked/40"
        >
          <Trash2 className="inline-block h-3 w-3 mr-1" /> Delete
        </button>
      </div>
      <ReportChart result={runQuery.data} />
    </div>
  );
}

function ReportChart({ result }: { result: ReportResult }): JSX.Element {
  // X-axis = first dimension. We pivot the remaining rows by the SECOND
  // dimension, if any, so each row becomes a grouped bar on the chart.
  const primary = result.dimensions[0]!;
  const secondary = result.dimensions[1] ?? null;

  if (!secondary) {
    const data = result.rows.map((r) => ({
      name: r.dimensionValues[primary] ?? '—',
      value: r.metricValue,
    }));
    return (
      <div className="rounded-md border border-border bg-card p-4">
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={data}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="value" fill={PALETTE[0]} radius={[4, 4, 0, 0]}>
              {data.map((_, idx) => (
                <Cell key={idx} fill={PALETTE[idx % PALETTE.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Pivot: rows[primary][secondary] = metric. Build distinct secondary keys
  // so each becomes a Bar series.
  const pivot = new Map<string, Record<string, number>>();
  const secondaryKeys = new Set<string>();
  for (const r of result.rows) {
    const p = r.dimensionValues[primary] ?? '—';
    const s = r.dimensionValues[secondary] ?? '—';
    secondaryKeys.add(s);
    const bucket = pivot.get(p) ?? {};
    bucket[s] = r.metricValue;
    pivot.set(p, bucket);
  }
  const data = Array.from(pivot.entries()).map(([name, bucket]) => ({ name, ...bucket }));
  const keys = Array.from(secondaryKeys);

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={data}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} />
          <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} allowDecimals={false} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {keys.map((k, idx) => (
            <Bar key={k} dataKey={k} fill={PALETTE[idx % PALETTE.length]} radius={[4, 4, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ReportEditorModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (id: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [dimensions, setDimensions] = useState<Dimension[]>(['status']);
  const [metric, setMetric] = useState<Metric>('count');
  const [filterText, setFilterText] = useState('{}');
  const [filterError, setFilterError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReportResult | null>(null);

  function parseFilters(): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(filterText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setFilterError('Filters must be a JSON object');
        return null;
      }
      setFilterError(null);
      return parsed as Record<string, unknown>;
    } catch (err) {
      setFilterError(err instanceof Error ? err.message : 'Invalid JSON');
      return null;
    }
  }

  const previewMutation = useMutation({
    mutationFn: async () => {
      const filters = parseFilters();
      if (filters === null) throw new Error('Fix filter JSON');
      return api.post<ReportResult>('/analytics/reports/preview', {
        name: name || 'Preview',
        dimensions,
        metric,
        filters,
      });
    },
    onSuccess: (data) => setPreview(data),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Preview failed'),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const filters = parseFilters();
      if (filters === null) throw new Error('Fix filter JSON');
      if (!name.trim()) throw new Error('Report name is required');
      return api.post<CustomReport>('/analytics/reports', {
        name,
        dimensions,
        metric,
        filters,
      });
    },
    onSuccess: (data) => onSaved(data.id),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Save failed'),
  });

  function toggleDim(d: Dimension): void {
    setDimensions((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : prev.length >= 3 ? prev : [...prev, d],
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl bg-card rounded-lg border border-border shadow-xl max-h-[90vh] overflow-auto">
        <header className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-semibold">New report</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              placeholder="Open tasks by assignee"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Dimensions (1–3, in order)
            </label>
            <div className="flex flex-wrap gap-1.5">
              {DIMENSIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDim(d)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs capitalize',
                    dimensions.includes(d)
                      ? 'bg-brand/10 border-brand/40 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {dimensions.includes(d) && (
                    <span className="mr-1 tabular-nums">{dimensions.indexOf(d) + 1}.</span>
                  )}
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Metric</label>
            <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
              {METRICS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMetric(m)}
                  className={cn(
                    'px-3 py-1.5',
                    metric === m
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/40',
                  )}
                >
                  {m.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Filters (JSON)
            </label>
            <textarea
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              rows={4}
              spellCheck={false}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
              placeholder='{ "statuses": ["Todo", "In Progress"] }'
            />
            {filterError && <p className="text-xs text-status-blocked mt-1">{filterError}</p>}
            <p className="text-[11px] text-muted-foreground mt-1">
              Supported keys: projectIds, statuses, priorities, assigneeUserIds, sprintIds, labelIds, createdAfter, createdBefore, dueBefore.
            </p>
          </div>
          {preview && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Preview</div>
              <ReportChart result={preview} />
            </div>
          )}
        </div>
        <footer className="px-6 py-3 border-t border-border flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending || dimensions.length === 0}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            {previewMutation.isPending ? 'Running…' : 'Preview'}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || dimensions.length === 0 || !name.trim()}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
