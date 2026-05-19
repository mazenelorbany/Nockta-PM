import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Layers, Sparkles, UserPlus, Users } from 'lucide-react';

import { api } from '../../../lib/api';
import { AvatarCircle } from '../../../components/task-bits';
import { queryKeys } from '../../../lib/query-keys';
import { apiErrorMessage } from '../utils';
import type {
  Access,
  AccessTeamOption,
  AccessUserOption,
  ProjectRole,
  SubjectKind,
} from '../types';

import { AccessGroup } from './AccessGroup';
import { AddGuestInline } from './AddGuestInline';
import { AddMemberInline } from './AddMemberInline';
import { AddTeamInline } from './AddTeamInline';
import { GrantRow } from './GrantRow';
import { InlineInviteGuestDialog } from './InlineInviteGuestDialog';

// =============================================================================
// ProjectAccessManager — the "who has access" panel inside Project Settings.
//
// Shows the existing grants, plus an "Add" row that lets a Manager pick a
// user OR a team and assign a role. Three rules baked in:
//
//   1. Clients (kind='client') can only get the 'Client' role. The role is
//      auto-selected and locked when a client is picked so a Manager can't
//      accidentally promote a guest to Contributor.
//   2. Teams can never carry the 'Client' role (spec §4 — clients are always
//      per-user). When the subject is a Team, the Client role is hidden.
//   3. Granting an internal user the 'Client' role is allowed but discouraged
//      — the form labels it as a downgrade so the operator sees the implication.
// =============================================================================

export function ProjectAccessManager({
  projectId,
  grants,
  loading,
}: {
  projectId: string;
  grants: Access[];
  loading: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);

  const usersQuery = useQuery({
    queryKey: ['users', 'list-all', 'with-guests'],
    queryFn: () =>
      // `kind=all` is the critical bit — the default returns only internal
      // members, which is why guests previously never appeared in the
      // grant picker. Without this the "Add Guest to project" flow simply
      // didn't surface any candidates and the team grouping appeared empty.
      api.get<{ items: AccessUserOption[]; nextCursor: string | null }>(
        '/users?limit=200&kind=all',
      ),
  });
  const teamsQuery = useQuery({
    queryKey: queryKeys.teams(),
    queryFn: () => api.get<AccessTeamOption[]>('/teams'),
  });

  const grantMutation = useMutation({
    mutationFn: (body: {
      subjectKind: SubjectKind;
      userId?: string;
      teamId?: string;
      role: ProjectRole;
    }) => api.post(`/projects/${projectId}/access`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
      toast.success('Access granted');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Grant failed')),
  });

  const revokeMutation = useMutation({
    mutationFn: (grantId: string) =>
      api.delete(`/projects/${projectId}/access/${grantId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
      toast.success('Access revoked');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Revoke failed')),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ grant, role }: { grant: Access; role: ProjectRole }) =>
      // The backend doesn't expose a PATCH on grants, so we delete + re-create.
      // Atomic enough for this UI — the row briefly shows the new role optimistically.
      (async () => {
        await api.delete(`/projects/${projectId}/access/${grant.id}`);
        return api.post(`/projects/${projectId}/access`, {
          subjectKind: grant.subjectKind,
          ...(grant.userId ? { userId: grant.userId } : {}),
          ...(grant.teamId ? { teamId: grant.teamId } : {}),
          role,
        });
      })(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Role update failed')),
  });

  const allUsers = usersQuery.data?.items ?? [];
  const teams = teamsQuery.data ?? [];

  // Already-granted subject ids — used to suppress them from the add picker so
  // a Manager can't double-grant the same user/team.
  const grantedUserIds = new Set(grants.filter((g) => g.userId).map((g) => g.userId!));
  const grantedTeamIds = new Set(grants.filter((g) => g.teamId).map((g) => g.teamId!));

  const internalUsers = allUsers
    .filter((u) => u.kind === 'internal' && !grantedUserIds.has(u.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const clientUsers = allUsers
    .filter((u) => u.kind === 'client' && !grantedUserIds.has(u.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const availableTeams = teams
    .filter((t) => !grantedTeamIds.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Bucket existing grants by kind for the grouped rendering below. Doing this
  // once at the top means the three groups iterate over disjoint slices and
  // can each render their own empty state.
  const memberGrants: Access[] = [];
  const teamGrants: Access[] = [];
  const guestGrants: Access[] = [];
  for (const g of grants) {
    if (g.subjectKind === 'team') {
      teamGrants.push(g);
    } else if (g.role === 'Client') {
      guestGrants.push(g);
    } else {
      memberGrants.push(g);
    }
  }

  // Resolve a grant to a typed display row. Looking up the user/team object
  // from the local lists gives us names + avatars without an extra query.
  function resolveUser(g: Access): AccessUserOption | null {
    if (!g.userId) return null;
    const u = allUsers.find((u) => u.id === g.userId);
    if (u) return u;
    if (g.user) {
      return {
        id: g.user.id,
        name: g.user.name,
        email: g.user.email,
        avatarUrl: null,
        kind: g.role === 'Client' ? 'client' : 'internal',
      };
    }
    return null;
  }

  return (
    <div className="space-y-6">
      {/* ----- Members ----- */}
      <AccessGroup
        id="access-members"
        title="Members"
        icon={<Users className="h-3.5 w-3.5" />}
        hint="Internal teammates with an explicit role on this project."
        empty={memberGrants.length === 0}
        emptyHint={
          loading
            ? 'Loading…'
            : 'No members yet. Add an internal teammate below, or add a Team to grant everyone on it at once.'
        }
      >
        {memberGrants.map((g) => {
          const u = resolveUser(g);
          return (
            <GrantRow
              key={g.id}
              avatar={
                <AvatarCircle
                  user={
                    u
                      ? {
                          id: u.id,
                          name: u.name,
                          ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
                        }
                      : null
                  }
                  size={32}
                />
              }
              primary={u?.name ?? u?.email ?? g.userId ?? ''}
              secondary={u?.email}
              currentRole={g.role}
              availableRoles={['Manager', 'Contributor', 'Viewer', 'Client']}
              onRoleChange={(role) => updateRoleMutation.mutate({ grant: g, role })}
              onRevoke={() => {
                if (window.confirm('Revoke this access grant?')) revokeMutation.mutate(g.id);
              }}
            />
          );
        })}
        <AddMemberInline
          internalUsers={internalUsers}
          pending={grantMutation.isPending}
          onSubmit={(userId, role) =>
            grantMutation.mutate({ subjectKind: 'user', userId, role })
          }
        />
      </AccessGroup>

      {/* ----- Teams ----- */}
      <AccessGroup
        id="access-teams"
        title="Teams"
        icon={<Layers className="h-3.5 w-3.5" />}
        hint="Granting a team grants every current and future member of that team in one shot."
        empty={teamGrants.length === 0}
        emptyHint={
          teams.length === 0 ? (
            <>
              No teams in this workspace yet. Create one under{' '}
              <a href="/settings/teams" className="text-brand hover:underline">
                Settings → Teams
              </a>
              .
            </>
          ) : (
            'No team grants yet. Add a team below to give everyone on it access at once.'
          )
        }
      >
        {teamGrants.map((g) => (
          <GrantRow
            key={g.id}
            avatar={
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand/15 text-brand">
                <Layers className="h-3.5 w-3.5" />
              </span>
            }
            primary={g.team?.name ?? g.teamId ?? ''}
            secondary={g.team?.slug ? `@${g.team.slug}` : undefined}
            badge={{ label: 'Team', tone: 'brand' }}
            currentRole={g.role}
            availableRoles={['Manager', 'Contributor', 'Viewer']}
            onRoleChange={(role) => updateRoleMutation.mutate({ grant: g, role })}
            onRevoke={() => {
              if (window.confirm('Revoke this team grant?')) revokeMutation.mutate(g.id);
            }}
          />
        ))}
        {availableTeams.length > 0 && (
          <AddTeamInline
            availableTeams={availableTeams}
            pending={grantMutation.isPending}
            onSubmit={(teamId, role) =>
              grantMutation.mutate({ subjectKind: 'team', teamId, role })
            }
          />
        )}
      </AccessGroup>

      {/* ----- Guests ----- */}
      <AccessGroup
        id="access-guests"
        title="Guests"
        icon={<Sparkles className="h-3.5 w-3.5" />}
        hint="External collaborators who sign in via magic link. They only see content marked client-visible, and can comment + report bugs."
        empty={guestGrants.length === 0}
        emptyHint={
          loading
            ? 'Loading…'
            : 'No guests on this project yet. Invite one below — the magic link will land in their inbox.'
        }
        action={
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Invite new guest
          </button>
        }
      >
        {guestGrants.map((g) => {
          const u = resolveUser(g);
          return (
            <GrantRow
              key={g.id}
              avatar={
                <AvatarCircle
                  user={
                    u
                      ? {
                          id: u.id,
                          name: u.name,
                          ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
                        }
                      : null
                  }
                  size={32}
                />
              }
              primary={u?.name ?? u?.email ?? g.userId ?? ''}
              secondary={u?.email}
              badge={{ label: 'Guest', tone: 'guest' }}
              currentRole={g.role}
              // Guests are locked to Client — surfacing other roles here would
              // be a footgun (and the backend would reject the change anyway).
              availableRoles={['Client']}
              onRoleChange={() => undefined}
              onRevoke={() => {
                if (window.confirm('Remove this guest from the project?')) revokeMutation.mutate(g.id);
              }}
            />
          );
        })}
        <AddGuestInline
          clientUsers={clientUsers}
          pending={grantMutation.isPending}
          onSubmit={(userId) =>
            grantMutation.mutate({ subjectKind: 'user', userId, role: 'Client' })
          }
          onInvite={() => setInviteOpen(true)}
        />
      </AccessGroup>

      {/* Inline invite-guest dialog. The endpoint atomically creates the
          user + grants project access + emails the invite, so the parent
          just needs to refresh both the users picker and the access list. */}
      {inviteOpen && (
        <InlineInviteGuestDialog
          projectId={projectId}
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            void queryClient.invalidateQueries({ queryKey: ['users', 'list-all'] });
            void queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
            setInviteOpen(false);
          }}
        />
      )}
    </div>
  );
}
