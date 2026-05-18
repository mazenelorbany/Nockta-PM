import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';

import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

// =============================================================================
// ArchivedProjectsPage — admin surface for the 7-day archive grace window
// (Pass 5 R4-deferred A).
//
// Lists every project with `archivedAt != null`. Each row shows:
//   - project name + key
//   - when it was archived (relative "3 days ago")
//   - time-until-purge ("Purges in 4 days") so the operator knows how much
//     runway they have to undo
//   - a Restore button that flips archivedAt back to null
//
// The actual purge job (ProjectsPurgeProcessor) runs nightly at 03:00 — see
// apps/api/src/modules/projects/projects-purge.processor.ts. This page does
// NOT trigger a purge; it only surfaces the queue and offers restore.
// =============================================================================

const GRACE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface ArchivedProject {
  id: string;
  key: string;
  name: string;
  description: string | null;
  archivedAt: string;
  createdAt: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
}

export function ArchivedProjectsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const archivedQuery = useQuery({
    queryKey: ['projects', 'archived'],
    queryFn: () => api.get<ArchivedProject[]>('/projects/archived/list'),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => api.post(`/projects/${id}/restore`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      void queryClient.invalidateQueries({ queryKey: ['projects', 'archived'] });
      toast.success('Project restored');
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError ? err.problem.title || err.message : 'Could not restore project',
      ),
  });

  const items = archivedQuery.data ?? [];

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-4 sm:py-5 border-b border-border">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-lg sm:text-xl font-semibold tracking-tight">Archived projects</h1>
        </div>
        <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
          Projects sit here for {GRACE_DAYS} days after archival. Restore them with one click before
          the nightly purge runs. After {GRACE_DAYS} days the row is hard-deleted and cannot be
          recovered.
        </p>
      </header>

      <div className="flex-1 overflow-auto p-4 sm:p-6 md:p-8">
        {archivedQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-muted-foreground py-12 text-center">
            <Archive className="h-8 w-8 mx-auto mb-3 text-muted-foreground/40" />
            No archived projects.
            <div className="mt-1 text-xs">
              When an Admin archives a project, it lands here until the {GRACE_DAYS}-day grace
              window expires.
            </div>
          </div>
        ) : (
          <div className="max-w-3xl overflow-hidden rounded-lg border border-border bg-card/40">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Project</th>
                  <th className="text-left font-medium px-4 py-2">Archived</th>
                  <th className="text-left font-medium px-4 py-2">Purge countdown</th>
                  <th className="text-right font-medium px-4 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const archivedAt = new Date(p.archivedAt);
                  const purgeAt = new Date(archivedAt.getTime() + GRACE_DAYS * MS_PER_DAY);
                  const msUntilPurge = purgeAt.getTime() - Date.now();
                  const daysUntilPurge = Math.max(0, Math.ceil(msUntilPurge / MS_PER_DAY));
                  const isExpired = msUntilPurge <= 0;
                  return (
                    <tr key={p.id} className="border-t border-border/60 hover:bg-accent/20">
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium">{p.name}</div>
                        <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
                          {p.key}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top text-muted-foreground text-xs">
                        {formatRelative(archivedAt)}
                      </td>
                      <td className="px-4 py-3 align-top">
                        {isExpired ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-destructive/20 text-destructive uppercase tracking-wide">
                            Pending purge
                          </span>
                        ) : (
                          <span className="text-xs text-priority-medium">
                            Purges in {daysUntilPurge} {daysUntilPurge === 1 ? 'day' : 'days'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top text-right">
                        <button
                          type="button"
                          onClick={() => restoreMut.mutate(p.id)}
                          disabled={restoreMut.isPending}
                          className="tap inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent/60 disabled:opacity-50 transition-colors"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Restore
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground border-t border-border/60">
              {items.length} {items.length === 1 ? 'project' : 'projects'} in the {GRACE_DAYS}-day
              grace window. Need to bring one back into rotation?{' '}
              <Link to="/projects" className="text-foreground hover:underline">
                Go to projects
              </Link>
              .
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact "3 days ago" / "5 hours ago" formatter. We avoid pulling in
 * date-fns just for this — the rest of the codebase uses `Intl.RelativeTimeFormat`
 * for the same job; mirror that.
 */
function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return d.toLocaleDateString();
}
