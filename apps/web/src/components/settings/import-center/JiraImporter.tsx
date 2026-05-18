import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { api } from '../../../lib/api';
import { apiErrorMessage } from '../primitives';

import { ImportProgressBar, useImportProgress } from './useImportProgress';
import { SourceHeader, Stat } from './shared';

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

export function JiraImporter({ rerunSnapshot }: { rerunSnapshot?: unknown }): JSX.Element {
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
