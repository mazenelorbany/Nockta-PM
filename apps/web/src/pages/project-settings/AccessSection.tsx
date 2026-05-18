import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import type { UseMutationResult } from '@tanstack/react-query';
import {
  ArrowRight,
  Layers,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { cn } from '@nockta/ui';
import { api } from '../../lib/api';
import { AvatarCircle } from '../../components/task-bits';
import { Section } from './shared';
import { ROLE_HINTS } from './constants';
import { apiErrorMessage } from './utils';
import type {
  Access,
  AccessTeamOption,
  AccessUserOption,
  Project,
  ProjectRole,
  SubjectKind,
} from './types';

export function AccessSection({
  draft,
  setDraft,
  updateMutation,
  projectId,
  grants,
  loading,
  grantSummary,
}: {
  draft: Project;
  setDraft: (next: Project) => void;
  updateMutation: UseMutationResult<Project, unknown, Partial<Project>, unknown>;
  projectId: string;
  grants: Access[];
  loading: boolean;
  grantSummary: { members: number; teams: number; guests: number; total: number };
}): JSX.Element {
  return (
    <Section
      id="access"
      icon={<ShieldCheck className="h-4 w-4" />}
      title="Access"
      hint="Who can see this project, and at what level. Members are internal teammates. Teams roll up everyone on the team. Guests use the client portal and only see what's marked client-visible."
    >
      {/* Chips strip — quick read on the shape of access. Clickable
          to scroll to the relevant subsection below. */}
      <div className="flex flex-wrap gap-2 mb-1">
        <AccessChip
          label="Members"
          count={grantSummary.members}
          icon={<Users className="h-3 w-3" />}
          href="#access-members"
        />
        <AccessChip
          label="Teams"
          count={grantSummary.teams}
          icon={<Layers className="h-3 w-3" />}
          href="#access-teams"
        />
        <AccessChip
          label="Guests"
          count={grantSummary.guests}
          icon={<Sparkles className="h-3 w-3" />}
          tone="guest"
          href="#access-guests"
        />
      </div>

      {/* Guest sharing mode — sits ABOVE the grant manager so it's the
          first decision a Manager makes when configuring access. The
          default ("Per-task") matches the legacy strict behavior; the
          Open option is what most client engagements want. */}
      <GuestSharingMode
        value={draft.defaultTaskVisibility}
        onChange={(v) => {
          setDraft({ ...draft, defaultTaskVisibility: v });
          updateMutation.mutate({ defaultTaskVisibility: v });
        }}
        hasGuests={grantSummary.guests > 0}
      />

      <ProjectAccessManager
        projectId={projectId}
        grants={grants}
        loading={loading}
      />
    </Section>
  );
}

function GuestSharingMode({
  value,
  onChange,
  hasGuests,
}: {
  value: 'internal' | 'client_visible';
  onChange: (v: 'internal' | 'client_visible') => void;
  hasGuests: boolean;
}): JSX.Element {
  // Two clearly-labeled cards rather than a toggle, because the implication
  // ("guests see every task" vs "guests see nothing by default") needs more
  // than a single sentence to land. Card layout keeps the chosen mode
  // visually obvious.
  const opts: {
    value: 'internal' | 'client_visible';
    label: string;
    body: string;
  }[] = [
    {
      value: 'internal',
      label: 'Curated',
      body:
        'Guests only see tasks marked client-visible. Default — picks safer for projects with sensitive internal work alongside client deliverables.',
    },
    {
      value: 'client_visible',
      label: 'Open',
      body:
        'Guests see every task on the project. New tasks default to client-visible. Use this when the whole project IS the client deliverable.',
    },
  ];
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-xs font-semibold tracking-tight">Guest sharing mode</div>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            What guests on this project see by default. You can still flip any
            individual task with the visibility toggle in its drawer.
          </p>
        </div>
        {!hasGuests && (
          <span className="text-[10px] text-muted-foreground/60 italic shrink-0 ml-2">
            No guests yet — this setting kicks in when you add one.
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {opts.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                'text-left rounded-md border px-3 py-2.5 transition-colors',
                active
                  ? 'border-brand bg-brand/10 ring-1 ring-brand/30'
                  : 'border-border bg-background/40 hover:bg-accent/40 hover:border-foreground/20',
              )}
              aria-pressed={active}
            >
              <div className="flex items-center justify-between mb-1">
                <span
                  className={cn(
                    'text-sm font-semibold',
                    active ? 'text-brand' : 'text-foreground',
                  )}
                >
                  {opt.label}
                </span>
                <span
                  className={cn(
                    'h-3 w-3 rounded-full border',
                    active ? 'border-brand bg-brand' : 'border-border bg-background',
                  )}
                  aria-hidden="true"
                />
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {opt.body}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AccessChip({
  label,
  count,
  icon,
  href,
  tone,
}: {
  label: string;
  count: number;
  icon: JSX.Element;
  href: string;
  tone?: 'guest';
}): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <a
      href={href}
      onClick={(e) => {
        // Push through React Router so the page-level hash-scroll effect fires.
        e.preventDefault();
        navigate(`${location.pathname}${href}`);
      }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
        count > 0
          ? tone === 'guest'
            ? 'border-priority-medium/40 bg-priority-medium/5 text-foreground hover:bg-priority-medium/10'
            : 'border-brand/40 bg-brand/5 text-foreground hover:bg-brand/10'
          : 'border-border bg-card/40 text-muted-foreground hover:text-foreground hover:bg-accent/40',
      )}
    >
      {icon}
      <span>{label}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{count}</span>
    </a>
  );
}

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

function ProjectAccessManager({
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
    queryKey: ['teams'],
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

      {/* Inline invite-guest dialog. After a successful invite we refresh the
          users list so the new guest shows up in the dropdown immediately. */}
      {inviteOpen && (
        <InlineInviteGuestDialog
          onClose={() => setInviteOpen(false)}
          onInvited={(user) => {
            // Refresh the user picker, then auto-grant the new guest to this
            // project so the Admin doesn't have to re-pick them.
            void queryClient.invalidateQueries({ queryKey: ['users', 'list-all'] });
            grantMutation.mutate({
              subjectKind: 'user',
              userId: user.id,
              role: 'Client',
            });
            setInviteOpen(false);
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
// AccessGroup — subsection container that gives Members/Teams/Guests a
// consistent header, optional inline action button, and an empty state. The
// id is used by anchor chips at the top of the Access section so clicking
// "Guests · 2" scrolls right to the group.
// =============================================================================

function AccessGroup({
  id,
  title,
  icon,
  hint,
  empty,
  emptyHint,
  action,
  children,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  hint: string;
  /** Caller signals whether the grant list is empty. Inferring this from
   *  children was unreliable because empty arrays / `false` branches still
   *  occupy a child slot in React. */
  empty: boolean;
  emptyHint: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section id={id} className="scroll-mt-24">
      <header className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        </div>
        {action}
      </header>
      <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{hint}</p>
      <div className="rounded-lg border border-border bg-card/40 overflow-hidden">
        {empty && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {emptyHint}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

// GrantRow — one access row with avatar, role select, revoke button.
function GrantRow({
  avatar,
  primary,
  secondary,
  badge,
  currentRole,
  availableRoles,
  onRoleChange,
  onRevoke,
}: {
  avatar: React.ReactNode;
  primary: string;
  secondary?: string | undefined;
  badge?: { label: string; tone: 'brand' | 'guest' } | undefined;
  currentRole: ProjectRole;
  availableRoles: ProjectRole[];
  onRoleChange: (role: ProjectRole) => void;
  onRevoke: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3 px-3 py-2 border-b border-border last:border-b-0 hover:bg-accent/20 transition-colors">
      <div className="shrink-0">{avatar}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium truncate">{primary}</span>
          {badge && (
            <span
              className={cn(
                'text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold shrink-0',
                badge.tone === 'brand'
                  ? 'bg-brand/15 text-brand'
                  : 'bg-priority-medium/15 text-priority-medium',
              )}
            >
              {badge.label}
            </span>
          )}
        </div>
        {secondary && (
          <div className="text-[11px] text-muted-foreground truncate">{secondary}</div>
        )}
      </div>
      <select
        value={currentRole}
        onChange={(e) => onRoleChange(e.target.value as ProjectRole)}
        disabled={availableRoles.length === 1}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs disabled:opacity-60 disabled:cursor-not-allowed"
        title={ROLE_HINTS[currentRole]}
      >
        {availableRoles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onRevoke}
        className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
        aria-label="Revoke access"
        title="Revoke"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// AddMemberInline — pick an internal user + role, hit Add.
function AddMemberInline({
  internalUsers,
  pending,
  onSubmit,
}: {
  internalUsers: AccessUserOption[];
  pending: boolean;
  onSubmit: (userId: string, role: ProjectRole) => void;
}): JSX.Element {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<ProjectRole>('Contributor');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!userId) return;
        onSubmit(userId, role);
        setUserId('');
        setRole('Contributor');
      }}
      className="flex flex-wrap items-center gap-2 px-3 py-2 bg-background/40 border-t border-border"
    >
      <select
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        className="flex-1 min-w-[180px] rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="">
          {internalUsers.length === 0 ? 'Everyone is already a member' : 'Pick a member…'}
        </option>
        {internalUsers.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name || u.email}
          </option>
        ))}
      </select>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as ProjectRole)}
        className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="Manager">Manager</option>
        <option value="Contributor">Contributor</option>
        <option value="Viewer">Viewer</option>
      </select>
      <button
        type="submit"
        disabled={!userId || pending}
        className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        Add member
      </button>
    </form>
  );
}

// AddTeamInline — pick a team + role.
function AddTeamInline({
  availableTeams,
  pending,
  onSubmit,
}: {
  availableTeams: AccessTeamOption[];
  pending: boolean;
  onSubmit: (teamId: string, role: ProjectRole) => void;
}): JSX.Element {
  const [teamId, setTeamId] = useState('');
  const [role, setRole] = useState<ProjectRole>('Contributor');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!teamId) return;
        onSubmit(teamId, role);
        setTeamId('');
        setRole('Contributor');
      }}
      className="flex flex-wrap items-center gap-2 px-3 py-2 bg-background/40 border-t border-border"
    >
      <select
        value={teamId}
        onChange={(e) => setTeamId(e.target.value)}
        className="flex-1 min-w-[180px] rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="">Pick a team…</option>
        {availableTeams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as ProjectRole)}
        className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="Manager">Manager</option>
        <option value="Contributor">Contributor</option>
        <option value="Viewer">Viewer</option>
      </select>
      <button
        type="submit"
        disabled={!teamId || pending}
        className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        Add team
      </button>
    </form>
  );
}

// AddGuestInline — pick an existing client user (always at role=Client) OR
// jump to the inline invite dialog if the right person isn't in the list yet.
function AddGuestInline({
  clientUsers,
  pending,
  onSubmit,
  onInvite,
}: {
  clientUsers: AccessUserOption[];
  pending: boolean;
  onSubmit: (userId: string) => void;
  onInvite: () => void;
}): JSX.Element {
  const [userId, setUserId] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!userId) return;
        onSubmit(userId);
        setUserId('');
      }}
      className="flex flex-wrap items-center gap-2 px-3 py-2 bg-background/40 border-t border-border"
    >
      <select
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        className="flex-1 min-w-[180px] rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="">
          {clientUsers.length === 0
            ? 'No guests in the workspace yet — invite one →'
            : 'Pick an existing guest…'}
        </option>
        {clientUsers.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name || u.email}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={!userId || pending}
        className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        Add guest
      </button>
      <span className="text-muted-foreground/70 text-xs">or</span>
      <button
        type="button"
        onClick={onInvite}
        className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
      >
        Invite new guest by email
        <ArrowRight className="h-3 w-3" />
      </button>
    </form>
  );
}

// InlineInviteGuestDialog — slim local version of the workspace-level
// InviteGuestDialog. Lives inline here so a Manager can spin up a brand-new
// guest and grant them access to this project without leaving Settings.
function InlineInviteGuestDialog({
  onClose,
  onInvited,
}: {
  onClose: () => void;
  onInvited: (user: { id: string; email: string; name: string }) => void;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  const invite = useMutation({
    mutationFn: () =>
      api.post<{
        id: string;
        email: string;
        name: string;
        kind: 'client';
        alreadyExisted: boolean;
      }>('/users/invite-guest', {
        email: email.trim().toLowerCase(),
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    onSuccess: (resp) => {
      toast.success(
        resp.alreadyExisted
          ? `Re-sent magic link to ${resp.email}`
          : `Invited ${resp.email}`,
      );
      onInvited({ id: resp.id, email: resp.email, name: resp.name });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Invite failed')),
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) invite.mutate();
        }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-2xl max-h-[85vh] overflow-y-auto"
      >
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-brand" />
            Invite a guest to this project
          </h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            We'll email them a one-time sign-in link. After the invite sends
            we'll automatically grant them Client access to this project.
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">
              Email <span className="text-destructive">*</span>
            </label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="someone@partner-co.com"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Must NOT be on the company domain — internal accounts use Google OAuth instead.
            </p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">
              Display name <span className="text-muted-foreground/60">(optional)</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Defaults to the email's local part"
              maxLength={120}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!email.trim() || invite.isPending}
            className="rounded-md bg-foreground text-background px-4 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {invite.isPending ? 'Sending…' : 'Send invite + grant access'}
          </button>
        </div>
      </form>
    </div>
  );
}
