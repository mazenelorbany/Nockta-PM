import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { Trash2 } from 'lucide-react';
import { cn } from '@nockta/ui';

import { api } from '../../../lib/api';
import { SectionTitle, apiErrorMessage } from '../primitives';
import { queryKeys } from '../../../lib/query-keys';

import type { UserDetail } from './types';

// =============================================================================
// UserProjectAccess — inline editor for project grants on a single user.
//
// Lists every project the user has access to (with role badge + source) and
// adds an "Add project" form at the bottom. Revoke shows only when the grant
// is a direct user grant — team-derived and public-visibility grants can't
// be revoked from this UI.
// =============================================================================

export function UserProjectAccess({
  userId,
  userKind,
  grants,
}: {
  userId: string;
  userKind: 'internal' | 'client';
  grants: UserDetail['projects'];
}): JSX.Element {
  const queryClient = useQueryClient();

  type ProjectOption = { id: string; key: string; name: string };
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ProjectOption[]>('/projects'),
  });
  const allProjects = projectsQuery.data ?? [];
  const grantedProjectIds = new Set(grants.map((g) => g.id));
  const candidates = allProjects.filter((p) => !grantedProjectIds.has(p.id));

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['user-detail', userId] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.members() });
  };

  const grant = useMutation({
    mutationFn: ({
      projectId,
      role,
    }: {
      projectId: string;
      role: 'Manager' | 'Contributor' | 'Viewer' | 'Client';
    }) =>
      api.post(`/projects/${projectId}/access`, {
        subjectKind: 'user',
        userId,
        role,
      }),
    onSuccess: () => {
      toast.success('Access granted');
      refresh();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Grant failed')),
  });

  const revoke = useMutation({
    mutationFn: ({ projectId, grantId }: { projectId: string; grantId: string }) =>
      api.delete(`/projects/${projectId}/access/${grantId}`),
    onSuccess: () => {
      toast.success('Access revoked');
      refresh();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Revoke failed')),
  });

  const updateRole = useMutation({
    mutationFn: async ({
      projectId,
      grantId,
      role,
    }: {
      projectId: string;
      grantId: string;
      role: 'Manager' | 'Contributor' | 'Viewer' | 'Client';
    }) => {
      await api.delete(`/projects/${projectId}/access/${grantId}`);
      return api.post(`/projects/${projectId}/access`, {
        subjectKind: 'user',
        userId,
        role,
      });
    },
    onSuccess: () => {
      toast.success('Role updated');
      refresh();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Role update failed')),
  });

  return (
    <section>
      <SectionTitle
        title="Project access"
        hint={
          userKind === 'client'
            ? 'Pick which projects this external user can see, and at what level. Viewer = read-only, Contributor = read + write.'
            : 'Direct project grants (in addition to team or public access).'
        }
      />
      {grants.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-border bg-card/30 p-4 text-xs text-muted-foreground text-center">
          No project access yet.
        </div>
      ) : (
        <ul className="mt-3 rounded-lg border border-border divide-y divide-border overflow-hidden">
          {grants.map((p) => (
            <li
              key={p.id}
              className="px-3 py-2 flex items-center gap-2 text-xs"
            >
              <span className="font-mono text-muted-foreground shrink-0">{p.key}</span>
              <span className="truncate flex-1">{p.name}</span>
              {p.source !== 'user' && (
                <span
                  className={cn(
                    'text-[9px] uppercase tracking-wider px-1.5 py-px rounded font-semibold shrink-0',
                    p.source === 'team' && 'bg-brand/15 text-brand',
                    p.source === 'public' && 'bg-secondary text-muted-foreground',
                    p.source === 'admin' && 'bg-priority-critical/15 text-priority-critical',
                  )}
                  title={`Granted via ${p.source}`}
                >
                  via {p.source}
                </span>
              )}
              <select
                value={p.role}
                onChange={(e) => {
                  if (!p.grantId) return;
                  updateRole.mutate({
                    projectId: p.id,
                    grantId: p.grantId,
                    role: e.target.value as 'Manager' | 'Contributor' | 'Viewer' | 'Client',
                  });
                }}
                disabled={!p.grantId || updateRole.isPending}
                className="rounded-md border border-input bg-background px-1.5 py-0.5 text-[11px] disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                title={
                  p.grantId
                    ? 'Change role'
                    : `Role inherited from ${p.source} — can't edit here`
                }
              >
                {/* Externals (kind='client') can now hold any project role —
                    the legacy "locked to Client" restriction was the gap the
                    user flagged. We surface Viewer / Contributor (the read /
                    write framing they asked for) plus Manager for the agency
                    case, and keep Client visible only when the current grant
                    still uses it (so a legacy row can be edited but new ones
                    default to the clearer Viewer/Contributor roles). */}
                {userKind === 'client' ? (
                  <>
                    <option value="Viewer">Viewer (read)</option>
                    <option value="Contributor">Contributor (write)</option>
                    <option value="Manager">Manager</option>
                    {p.role === 'Client' && <option value="Client">Client (legacy)</option>}
                  </>
                ) : (
                  <>
                    <option value="Manager">Manager</option>
                    <option value="Contributor">Contributor</option>
                    <option value="Viewer">Viewer</option>
                    {p.role === 'Client' && <option value="Client">Client</option>}
                  </>
                )}
              </select>
              <button
                type="button"
                onClick={() => {
                  if (p.grantId) {
                    if (window.confirm(`Revoke ${p.key} access for this user?`)) {
                      revoke.mutate({ projectId: p.id, grantId: p.grantId });
                    }
                    return;
                  }
                  if (p.source === 'team') {
                    toast(
                      `Access via team membership. Open the user's Teams section above and unselect the team that grants ${p.key}.`,
                      { duration: 5000 },
                    );
                  } else if (p.source === 'public') {
                    if (
                      window.confirm(
                        `${p.key} is set to Public visibility — every internal member can see it. Open project settings to change visibility?`,
                      )
                    ) {
                      window.open(`/projects/${p.id}/settings#access`, '_blank');
                    }
                  } else if (p.source === 'admin') {
                    toast(
                      'This user is an Admin and sees every project automatically. Change their Workspace standing above to revoke.',
                      { duration: 5000 },
                    );
                  } else {
                    toast.error('No removable grant on this project.');
                  }
                }}
                disabled={revoke.isPending}
                className="text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                aria-label="Revoke access"
                title={
                  p.grantId
                    ? 'Revoke access'
                    : p.source === 'team'
                      ? 'Granted via team — click for details'
                      : p.source === 'public'
                        ? 'Project is public — click to open settings'
                        : p.source === 'admin'
                          ? 'User is Admin — click for details'
                          : 'Remove access'
                }
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <UserProjectAddRow
        candidates={candidates}
        userKind={userKind}
        pending={grant.isPending}
        onAdd={(projectId, role) => grant.mutate({ projectId, role })}
      />
    </section>
  );
}

function UserProjectAddRow({
  candidates,
  userKind,
  pending,
  onAdd,
}: {
  candidates: Array<{ id: string; key: string; name: string }>;
  userKind: 'internal' | 'client';
  pending: boolean;
  onAdd: (
    projectId: string,
    role: 'Manager' | 'Contributor' | 'Viewer' | 'Client',
  ) => void;
}): JSX.Element {
  const [projectId, setProjectId] = useState('');
  // Default external users to Viewer (read-only) — safer than the legacy
  // Client role, and matches the most common "share this project with a
  // collaborator" intent. Admin can bump to Contributor if write is needed.
  const [role, setRole] = useState<'Manager' | 'Contributor' | 'Viewer' | 'Client'>(
    userKind === 'client' ? 'Viewer' : 'Contributor',
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!projectId) return;
        onAdd(projectId, role);
        setProjectId('');
      }}
      className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-card/30 px-3 py-2"
    >
      <select
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        className="flex-1 min-w-[160px] rounded-md border border-input bg-background px-2 py-1.5 text-xs"
        aria-label="Project to grant"
      >
        <option value="">
          {candidates.length === 0 ? 'Already on every project' : 'Add to a project…'}
        </option>
        {candidates.map((p) => (
          <option key={p.id} value={p.id}>
            {p.key} · {p.name}
          </option>
        ))}
      </select>
      <select
        value={role}
        onChange={(e) =>
          setRole(e.target.value as 'Manager' | 'Contributor' | 'Viewer' | 'Client')
        }
        className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
        title="Pick a role"
        aria-label="Role"
      >
        {userKind === 'client' ? (
          <>
            <option value="Viewer">Viewer (read)</option>
            <option value="Contributor">Contributor (write)</option>
            <option value="Manager">Manager</option>
          </>
        ) : (
          <>
            <option value="Manager">Manager</option>
            <option value="Contributor">Contributor</option>
            <option value="Viewer">Viewer</option>
          </>
        )}
      </select>
      <button
        type="submit"
        disabled={!projectId || pending}
        className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {pending ? 'Adding…' : 'Add'}
      </button>
    </form>
  );
}
