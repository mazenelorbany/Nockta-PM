import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Archive, ArchiveRestore, Trash2, UserCog } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { cn } from '@nockta/ui';
import { api } from '../../lib/api';
import { AdminGate, SectionTitle, apiErrorMessage } from './primitives';

// =============================================================================
// ProjectsAdminTab — workspace-wide project lifecycle. Archive hides a project
// from the sidebar; restore brings it back; delete (gated by typing the key)
// is permanent. Per-project content settings live inside each project.
// =============================================================================

interface AdminProject {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  workflowPreset: 'engineering' | 'design' | 'generic';
  sprintsEnabled?: boolean;
  archivedAt: string | null;
}

export function ProjectsAdminTab({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<AdminProject[]>('/projects'),
  });

  const archive = useMutation({
    mutationFn: (id: string) =>
      api.patch(`/projects/${id}`, { archivedAt: new Date().toISOString() }),
    onSuccess: () => {
      toast.success('Project archived');
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not archive')),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.patch(`/projects/${id}`, { archivedAt: null }),
    onSuccess: () => {
      toast.success('Project restored');
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not restore')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${id}`),
    onSuccess: () => {
      toast.success('Project deleted');
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete')),
  });

  if (!isAdmin) return <AdminGate />;

  const projects = projectsQuery.data ?? [];
  const active = projects.filter((p) => !p.archivedAt);
  const archived = projects.filter((p) => p.archivedAt);

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-4xl space-y-6 sm:space-y-8">
      <SectionTitle
        title={'Projects'}
        hint={'Archive, restore, or remove projects across the workspace. Per-project settings live inside each project.'}
      />

      <ProjectGroup
        label="Active"
        projects={active}
        actions={(p) => (
          <>
            {/* Jump straight into the per-project settings without leaving
                the admin page first. */}
            <NavLink
              to={`/projects/${p.id}/settings`}
              className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors"
              title="Open project settings"
            >
              <UserCog className="h-3 w-3" />
              Settings
            </NavLink>
            <button
              type="button"
              onClick={() => archive.mutate(p.id)}
              className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors"
              title="Archive — hides from sidebar; can be restored anytime"
            >
              <Archive className="h-3 w-3" />
              Archive
            </button>
            <ProjectDeleteButton onConfirm={() => remove.mutate(p.id)} projectKey={p.key} />
          </>
        )}
      />

      <ProjectGroup
        label="Archived"
        projects={archived}
        emptyText="No archived projects."
        actions={(p) => (
          <>
            <button
              type="button"
              onClick={() => restore.mutate(p.id)}
              className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors"
            >
              <ArchiveRestore className="h-3 w-3" />
              Restore
            </button>
            <ProjectDeleteButton onConfirm={() => remove.mutate(p.id)} projectKey={p.key} />
          </>
        )}
      />
    </div>
  );
}

function ProjectGroup({
  label,
  projects,
  actions,
  emptyText,
}: {
  label: string;
  projects: AdminProject[];
  actions: (p: AdminProject) => React.ReactNode;
  emptyText?: string;
}): JSX.Element {
  return (
    <fieldset className="border-0 p-0 m-0">
      <legend className="mb-2 flex items-baseline justify-between w-full">
        <h3 className="text-sm font-semibold tracking-tight">{label}</h3>
        <span className="nockta-eyebrow text-muted-foreground">{projects.length}</span>
      </legend>
      {projects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
          {emptyText ?? 'Nothing here.'}
        </div>
      ) : (
        <ul className="rounded-lg border border-border divide-y divide-border bg-card/40 overflow-hidden">
          {projects.map((p) => (
            <li
              key={p.id}
              className="row-hover px-4 py-3 flex items-center gap-3"
            >
              <span className="text-[10px] font-mono text-muted-foreground bg-secondary px-1.5 py-0.5 rounded shrink-0">
                {p.key}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{p.name}</div>
                {p.description && (
                  <div className="text-xs text-muted-foreground truncate">{p.description}</div>
                )}
              </div>
              <span
                className={cn(
                  'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-semibold shrink-0',
                  p.workflowPreset === 'engineering' && 'bg-brand/15 text-brand',
                  p.workflowPreset === 'design' && 'bg-status-in-review/15 text-status-in-review',
                  p.workflowPreset === 'generic' && 'bg-muted text-muted-foreground',
                )}
              >
                {p.workflowPreset}
              </span>
              {p.sprintsEnabled && (
                <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-semibold shrink-0 bg-secondary text-muted-foreground">
                  Sprints
                </span>
              )}
              <div className="flex items-center gap-1.5 shrink-0">{actions(p)}</div>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function ProjectDeleteButton({
  onConfirm,
  projectKey,
}: {
  onConfirm: () => void;
  projectKey: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => {
        const input = window.prompt(
          `Permanently delete this project? Type ${projectKey} to confirm.`,
        );
        if (input === projectKey) onConfirm();
        else if (input) toast.error('Key did not match — nothing deleted');
      }}
      className="tap inline-flex items-center justify-center rounded-md w-7 h-7 text-muted-foreground hover:bg-status-blocked/10 hover:text-status-blocked transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      title="Delete project"
      aria-label="Delete project"
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
