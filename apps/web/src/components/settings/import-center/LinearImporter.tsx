import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { api } from '../../../lib/api';
import { apiErrorMessage } from '../primitives';

import { ImportProgressBar, useImportProgress } from './useImportProgress';
import { SourceHeader, Stat } from './shared';

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

export function LinearImporter({ rerunSnapshot }: { rerunSnapshot?: unknown }): JSX.Element {
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
