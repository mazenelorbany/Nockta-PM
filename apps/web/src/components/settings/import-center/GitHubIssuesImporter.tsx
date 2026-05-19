import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { api } from '../../../lib/api';
import { GithubIcon } from '../../icons/GithubIcon';
import { apiErrorMessage } from '../primitives';
import { queryKeys } from '../../../lib/query-keys';

import { ImportProgressBar, useImportProgress } from './useImportProgress';
import { SourceHeader, Stat } from './shared';

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

export function GitHubIssuesImporter({ rerunSnapshot }: { rerunSnapshot?: unknown }): JSX.Element {
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
    queryKey: queryKeys.projects(),
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
        icon={<GithubIcon className="h-5 w-5" />}
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
