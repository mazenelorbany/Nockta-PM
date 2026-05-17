import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { UserMinus } from 'lucide-react';
import { SkeletonList, Spinner } from '@nockta/ui';
import { api } from '../../lib/api';
import { AvatarCircle } from '../task-bits';
import { AdminGate, Fieldset, HelpHint, SectionTitle, apiErrorMessage } from './primitives';

// =============================================================================
// TeamsTab — workspace teams + member management. Expanding a row reveals an
// inline editor for name/description + the member roster.
// =============================================================================

export interface Team {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: string;
  _count?: { members: number };
}

interface TeamDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  members: Array<{
    teamId: string;
    userId: string;
    joinedAt: string;
    user: { id: string; name: string | null; email: string; avatarUrl: string | null };
  }>;
}

interface PickerUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string | null;
}

export function TeamsTab({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<Team[]>('/teams'),
  });
  const [openCreate, setOpenCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const deleteTeam = useMutation({
    mutationFn: (id: string) => api.delete(`/teams/${id}`),
    onSuccess: () => {
      toast.success('Team deleted');
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      setExpandedId(null);
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete team')),
  });

  if (!isAdmin) return <AdminGate />;

  const teams = teamsQuery.data ?? [];

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-4xl space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <SectionTitle
          title={t('settings.teams.title', 'Teams')}
          hint={
            teams.length > 0
              ? t('settings.teams.summary_count', '{{count}} teams · click a row to manage members.', {
                  count: teams.length,
                })
              : t('settings.teams.summary_empty', 'Used for filtering, assignments, and access grants.')
          }
        />
        <button
          type="button"
          onClick={() => setOpenCreate(true)}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity"
        >
          New team
        </button>
      </div>

      <Fieldset
        legend="Roster"
        hint="Teams are filterable in views and grantable on individual projects."
      >
        <div className="rounded-lg border border-border overflow-hidden -mx-1">
          {teamsQuery.isLoading ? (
            <div className="p-3">
              <SkeletonList rows={3} rowClassName="h-10" />
            </div>
          ) : teams.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No teams yet. Create one to start grouping engineers.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {teams.map((t) => {
                const expanded = expandedId === t.id;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : t.id)}
                      aria-expanded={expanded}
                      className="row-hover w-full px-4 py-3 flex items-center justify-between text-left"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate flex items-center gap-1">
                          {t.name}
                          {!t.description && (
                            <HelpHint hint="Click to add a description and manage members." />
                          )}
                        </div>
                        {t.description && (
                          <div className="text-xs text-muted-foreground truncate">
                            {t.description}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-secondary text-muted-foreground">
                          {t._count?.members ?? 0}{' '}
                          {t._count?.members === 1 ? 'member' : 'members'}
                        </span>
                        <span className="text-xs font-mono text-muted-foreground">
                          {t.slug}
                        </span>
                      </div>
                    </button>
                    {expanded && (
                      <TeamDetailPanel
                        teamId={t.id}
                        onDelete={() => {
                          if (
                            window.confirm(
                              `Delete team "${t.name}"? Members are NOT deleted — only their team grant is removed.`,
                            )
                          ) {
                            deleteTeam.mutate(t.id);
                          }
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Fieldset>

      {openCreate && (
        <CreateTeamDialog
          onClose={() => setOpenCreate(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['teams'] });
            setOpenCreate(false);
          }}
        />
      )}
    </div>
  );
}

function TeamDetailPanel({
  teamId,
  onDelete,
}: {
  teamId: string;
  onDelete: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const teamQuery = useQuery({
    queryKey: ['team-detail', teamId],
    queryFn: () => api.get<TeamDetail>(`/teams/${teamId}`),
  });
  const usersQuery = useQuery({
    queryKey: ['members', 'internal'],
    queryFn: () => api.get<{ items: PickerUser[] }>('/users?limit=200&kind=internal'),
  });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [picker, setPicker] = useState('');

  useEffect(() => {
    if (teamQuery.data) {
      setName(teamQuery.data.name);
      setDescription(teamQuery.data.description ?? '');
    }
  }, [teamQuery.data]);

  const addMember = useMutation({
    mutationFn: (userId: string) =>
      api.post(`/teams/${teamId}/members/${userId}`, {}),
    onSuccess: () => {
      toast.success('Member added');
      void queryClient.invalidateQueries({ queryKey: ['team-detail', teamId] });
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not add member')),
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      api.delete(`/teams/${teamId}/members/${userId}`),
    onSuccess: () => {
      toast.success('Member removed');
      void queryClient.invalidateQueries({ queryKey: ['team-detail', teamId] });
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not remove member')),
  });
  const saveTeam = useMutation({
    mutationFn: () =>
      api.patch(`/teams/${teamId}`, {
        name: name.trim(),
        description: description.trim() || null,
      }),
    onSuccess: () => {
      toast.success('Team updated');
      void queryClient.invalidateQueries({ queryKey: ['team-detail', teamId] });
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      setEditing(false);
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not save')),
  });

  if (teamQuery.isLoading) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground flex items-center gap-2">
        <Spinner /> Loading team…
      </div>
    );
  }
  if (!teamQuery.data) {
    return <div className="px-4 py-3 text-xs text-status-blocked">Could not load team.</div>;
  }
  const team = teamQuery.data;
  const memberIds = new Set(team.members.map((m) => m.userId));
  const availableUsers = (usersQuery.data?.items ?? []).filter(
    (u) =>
      !memberIds.has(u.id) &&
      `${u.name ?? ''} ${u.email}`.toLowerCase().includes(picker.toLowerCase()),
  );

  return (
    <div className="bg-card/30 border-t border-border px-4 py-4 space-y-4">
      {/* Edit name / description */}
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          {editing ? (
            <>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Team name"
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              />
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm resize-none"
              />
            </>
          ) : (
            <div>
              <div className="text-sm font-medium">{team.name}</div>
              <div className="text-xs text-muted-foreground">
                {team.description || <span className="italic">No description</span>}
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-1">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => saveTeam.mutate()}
                disabled={saveTeam.isPending || !name.trim()}
                className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setName(team.name);
                  setDescription(team.description ?? '');
                }}
                className="rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="rounded-md border border-status-blocked/40 px-2.5 py-1 text-xs text-status-blocked hover:bg-status-blocked/10"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {/* Members */}
      <div>
        <div className="nockta-eyebrow text-muted-foreground mb-2">
          Members · {team.members.length}
        </div>
        {team.members.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">No members yet.</div>
        ) : (
          <ul className="rounded-md border border-border divide-y divide-border overflow-hidden">
            {team.members.map((m) => (
              <li
                key={m.userId}
                className="px-3 py-2 flex items-center gap-3 text-sm bg-background/40"
              >
                <AvatarCircle
                  user={{
                    id: m.user.id,
                    email: m.user.email,
                    ...(m.user.name ? { name: m.user.name } : {}),
                    ...(m.user.avatarUrl ? { avatarUrl: m.user.avatarUrl } : {}),
                  }}
                  size={24}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {m.user.name || m.user.email}
                  </div>
                  {m.user.name && (
                    <div className="text-xs text-muted-foreground truncate">
                      {m.user.email}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removeMember.mutate(m.userId)}
                  className="text-xs text-muted-foreground hover:text-status-blocked"
                  title="Remove from team"
                  aria-label={`Remove ${m.user.name || m.user.email} from team`}
                >
                  <UserMinus className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Add member picker */}
      <div>
        <div className="nockta-eyebrow text-muted-foreground mb-2">Add member</div>
        <input
          value={picker}
          onChange={(e) => setPicker(e.target.value)}
          placeholder="Search internal users by name or email"
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        {picker && (
          <ul className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border divide-y divide-border">
            {availableUsers.slice(0, 25).map((u) => (
              <li
                key={u.id}
                className="px-3 py-1.5 flex items-center justify-between text-sm hover:bg-accent/40 cursor-pointer"
                onClick={() => {
                  addMember.mutate(u.id);
                  setPicker('');
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <AvatarCircle user={u} size={22} />
                  <span className="truncate">{u.name || u.email}</span>
                </div>
                <span className="text-xs text-muted-foreground truncate">
                  {u.email}
                </span>
              </li>
            ))}
            {availableUsers.length === 0 && (
              <li className="px-3 py-2 text-xs text-muted-foreground italic">
                No matching users.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function CreateTeamDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post('/teams', {
        name: name.trim(),
        slug: slug.trim().toLowerCase(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: () => {
      toast.success('Team created');
      onCreated();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not create team')),
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">New team</h2>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">Name</label>
            <input
              required
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slug)
                  setSlug(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, ''),
                  );
              }}
              maxLength={120}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">Slug</label>
            <input
              required
              value={slug}
              onChange={(e) =>
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
              }
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">Description</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none"
            />
          </div>
        </div>
        <div className="px-6 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || !slug.trim() || create.isPending}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create team'}
          </button>
        </div>
      </form>
    </div>
  );
}
