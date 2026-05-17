import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Search,
  Trash2,
  UserCog,
  UserPlus,
  Users as UsersIcon,
} from 'lucide-react';
import { SkeletonList, Spinner, cn } from '@nockta/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-store';
import { AvatarCircle } from '../task-bits';
import {
  AdminGate,
  EditableField,
  HelpHint,
  SectionTitle,
  apiErrorMessage,
} from './primitives';
import type { Team } from './TeamsTab';

// =============================================================================
// MembersTab — the "people" tab. Lists internal members, clients, and archived
// accounts; lets an Admin search, filter by team, sort, change role, archive,
// and open a per-user drawer for deeper edits (teams + project access).
// =============================================================================

interface MemberUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string | null;
  companyRole: 'Admin' | 'Member' | null;
  kind?: 'internal' | 'client';
  archivedAt?: string | null;
  createdAt?: string;
  lastSeenAt?: string | null;
  teams?: Array<{ id: string; slug: string; name: string }>;
}

type KindFilter = 'internal' | 'client' | 'archived';
type CompanyRole = 'Admin' | 'Member';
type SortField = 'name' | 'role' | 'joined' | 'lastSeen';
type SortDir = 'asc' | 'desc';

interface UserDetail {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string | null;
  kind: 'internal' | 'client';
  companyRole: 'Admin' | 'Member' | null;
  archivedAt: string | null;
  createdAt: string;
  teams: Array<{ id: string; slug: string; name: string; description: string | null }>;
  projects: Array<{
    id: string;
    key: string;
    name: string;
    visibility: 'public' | 'teams' | 'private';
    role: 'Manager' | 'Contributor' | 'Viewer' | 'Client';
    source: 'admin' | 'user' | 'team' | 'public';
    grantId: string | null;
  }>;
}

export function MembersTab({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const { user: me } = useAuth();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<KindFilter>('internal');
  const [teamFilter, setTeamFilter] = useState<string | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const apiQuery = kind === 'archived'
    ? '/users?limit=200&kind=all&archived=true'
    : `/users?limit=200&kind=${kind}`;

  const membersQuery = useQuery({
    queryKey: ['members', kind],
    queryFn: () => api.get<{ items: MemberUser[] }>(apiQuery),
    enabled: isAdmin,
  });
  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<Team[]>('/teams'),
    enabled: isAdmin,
  });

  const setRole = useMutation({
    mutationFn: (input: { id: string; role: CompanyRole }) =>
      api.patch(`/users/${input.id}/role`, { role: input.role }),
    onSuccess: () => {
      toast.success('Role updated');
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      void queryClient.invalidateQueries({ queryKey: ['user-detail'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update role')),
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.delete(`/users/${id}`),
    onSuccess: () => {
      toast.success('Member archived');
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not archive member')),
  });
  const unarchive = useMutation({
    mutationFn: (id: string) => api.post(`/users/${id}/unarchive`, {}),
    onSuccess: () => {
      toast.success('Member restored');
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not restore member')),
  });

  const filtered = useMemo(() => {
    const members = membersQuery.data?.items ?? [];
    return members.filter((m) => {
      if (!`${m.name ?? ''} ${m.email}`.toLowerCase().includes(filter.toLowerCase())) {
        return false;
      }
      if (teamFilter !== 'all') {
        if (!m.teams?.some((t) => t.id === teamFilter)) return false;
      }
      return true;
    });
  }, [membersQuery.data, filter, teamFilter]);

  // Sorting — pulled into a memo so toggling sortField/Dir avoids resorting
  // on every render. roleRank gives Admin > Member > Client > unranked so a
  // sort by role buckets accounts the way an admin reads them.
  const sorted = useMemo(() => {
    const rows = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    const roleRank = (m: MemberUser): number => {
      if (m.companyRole === 'Admin') return 0;
      if (m.companyRole === 'Member') return 1;
      if (m.kind === 'client') return 2;
      return 3;
    };
    rows.sort((a, b) => {
      switch (sortField) {
        case 'name': {
          const an = (a.name || a.email).toLowerCase();
          const bn = (b.name || b.email).toLowerCase();
          return an < bn ? -1 * dir : an > bn ? 1 * dir : 0;
        }
        case 'role': {
          const diff = roleRank(a) - roleRank(b);
          return diff * dir;
        }
        case 'joined': {
          const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return (at - bt) * dir;
        }
        case 'lastSeen': {
          const at = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
          const bt = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
          return (at - bt) * dir;
        }
      }
    });
    return rows;
  }, [filtered, sortField, sortDir]);

  if (!isAdmin) return <AdminGate />;

  const headerHint =
    kind === 'internal'
      ? `${sorted.length} internal ${sorted.length === 1 ? 'member' : 'members'}`
      : kind === 'client'
      ? `${sorted.length} ${sorted.length === 1 ? 'client' : 'clients'}`
      : `${sorted.length} archived ${sorted.length === 1 ? 'account' : 'accounts'}`;

  function toggleSort(field: SortField): void {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-5xl space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 sm:gap-4 flex-wrap">
        <SectionTitle title={t('settings.members.title', 'People')} hint={headerHint} />
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 sm:flex-initial min-w-0">
            <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('settings.members.search_placeholder', 'Search by name or email…')}
              className="field text-xs py-1.5 ps-8 w-full sm:w-64"
              aria-label={t('common.search', 'Search')}
            />
          </div>
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="tap inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition-opacity"
            title="Email a magic-link to an external client"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Invite guest
          </button>
        </div>
      </div>

      {/* Segmented control: Internal / Clients / Archived */}
      <div className="inline-flex items-center rounded-md border border-border bg-card/30 p-0.5 text-xs">
        {(['internal', 'client', 'archived'] as KindFilter[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={cn(
              'px-3 py-1 rounded-sm transition-colors capitalize',
              kind === k
                ? 'bg-accent text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {k === 'client' ? 'Clients' : k === 'internal' ? 'Internal' : 'Archived'}
          </button>
        ))}
      </div>

      {/* Team filter chips (only meaningful for internal members) */}
      {kind === 'internal' && (teamsQuery.data?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setTeamFilter('all')}
            className={cn(
              'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
              teamFilter === 'all'
                ? 'border-brand text-brand bg-brand/10'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            All teams
          </button>
          {(teamsQuery.data ?? []).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTeamFilter(t.id)}
              className={cn(
                'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                teamFilter === t.id
                  ? 'border-brand text-brand bg-brand/10'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {kind === 'internal' && (
        <div className="rounded-lg border border-border bg-card/40 p-4 flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand/10 text-brand shrink-0">
            <UsersIcon className="h-4 w-4" />
          </div>
          <div className="text-xs text-muted-foreground leading-relaxed">
            <span className="text-foreground font-medium inline-flex items-center gap-1">
              How members join.
              <HelpHint hint="Auto-provision is gated by Google OAuth domain. Anyone outside the company domain has to be invited as a guest." />
            </span>{' '}
            Anyone with an <code className="font-mono text-foreground/80">@nockta.com</code>{' '}
            Google account auto-provisions as a Member on first sign-in. Click a row to
            change role, manage team assignments, or archive the account.
          </div>
        </div>
      )}

      {membersQuery.isLoading ? (
        <SkeletonList rows={6} rowClassName="h-12" />
      ) : sorted.length === 0 ? (
        <div className="rounded-lg border border-border p-6 text-center text-xs text-muted-foreground">
          No accounts match these filters.
        </div>
      ) : (
        <PeopleTable
          rows={sorted}
          meId={me?.id}
          archivedView={kind === 'archived'}
          sortField={sortField}
          sortDir={sortDir}
          onToggleSort={toggleSort}
          onSetSort={(f, d) => {
            setSortField(f);
            setSortDir(d);
          }}
          onOpen={(id) => setSelectedId(id)}
          onSetRole={(id, role) => setRole.mutate({ id, role })}
          onArchive={(id) => {
            if (window.confirm('Archive this account? They will be signed out immediately.')) {
              archive.mutate(id);
            }
          }}
          onUnarchive={(id) => unarchive.mutate(id)}
        />
      )}

      {selectedId && (
        <UserDrawer
          userId={selectedId}
          meId={me?.id}
          teams={teamsQuery.data ?? []}
          onClose={() => setSelectedId(null)}
        />
      )}

      {inviteOpen && (
        <InviteGuestDialog
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            // Refresh members so the new guest appears immediately, and flip
            // the kind tab so the admin sees the new row land in Clients.
            void queryClient.invalidateQueries({ queryKey: ['members'] });
            setKind('client');
            setInviteOpen(false);
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
// PeopleTable — desktop table + mobile stacked-card view of members.
//
// At `md+` we render a real <table> with sortable column headers. Below that
// breakpoint we render the same rows as cards so the user doesn't have to
// horizontally scroll on a phone. Sort buttons stay accessible on mobile
// via a small sort control above the cards.
// =============================================================================

function PeopleTable({
  rows,
  meId,
  archivedView,
  sortField,
  sortDir,
  onToggleSort,
  onSetSort,
  onOpen,
  onSetRole,
  onArchive,
  onUnarchive,
}: {
  rows: MemberUser[];
  meId: string | undefined;
  archivedView: boolean;
  sortField: SortField;
  sortDir: SortDir;
  onToggleSort: (field: SortField) => void;
  /** Used by the mobile dropdown to set both axes in a single state update. */
  onSetSort: (field: SortField, dir: SortDir) => void;
  onOpen: (id: string) => void;
  onSetRole: (id: string, role: CompanyRole) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
}): JSX.Element {
  return (
    <>
      {/* Mobile: sort control above the stacked cards. */}
      <div className="md:hidden flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{rows.length} rows</span>
        <label className="inline-flex items-center gap-1">
          Sort by
          <select
            value={`${sortField}-${sortDir}`}
            onChange={(e) => {
              const [f, d] = e.target.value.split('-') as [SortField, SortDir];
              onSetSort(f, d);
            }}
            className="rounded-md border border-input bg-background px-1.5 py-0.5 text-xs"
            aria-label="Sort members"
          >
            <option value="name-asc">Name (A–Z)</option>
            <option value="name-desc">Name (Z–A)</option>
            <option value="role-asc">Role (Admin first)</option>
            <option value="role-desc">Role (last)</option>
            <option value="joined-desc">Joined (newest)</option>
            <option value="joined-asc">Joined (oldest)</option>
            <option value="lastSeen-desc">Last seen (recent)</option>
            <option value="lastSeen-asc">Last seen (oldest)</option>
          </select>
        </label>
      </div>

      {/* Mobile: stacked cards. */}
      <ul className="md:hidden space-y-2 mt-2">
        {rows.map((m) => {
          const isMe = m.id === meId;
          const display = displayMember(m);
          const targetRole: CompanyRole = m.companyRole === 'Admin' ? 'Member' : 'Admin';
          return (
            <li
              key={m.id}
              className="rounded-lg border border-border bg-card/60 p-3 flex flex-col gap-2"
            >
              <button
                type="button"
                onClick={() => onOpen(m.id)}
                className="flex items-center gap-3 text-left w-full min-w-0"
              >
                <AvatarCircle user={m} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate flex items-center gap-1.5 flex-wrap">
                    <span className={cn(display.muted && 'text-muted-foreground italic')}>
                      {display.name}
                    </span>
                    {isMe && (
                      <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-px">
                        You
                      </span>
                    )}
                    {m.kind === 'client' && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-brand/15 text-brand font-semibold">
                        Client
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {display.secondary}
                  </div>
                </div>
                <span
                  className={cn(
                    'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md font-semibold shrink-0',
                    m.companyRole === 'Admin'
                      ? 'bg-brand/15 text-brand'
                      : 'bg-secondary text-muted-foreground',
                  )}
                >
                  {m.companyRole ?? (m.kind === 'client' ? 'Client' : 'Member')}
                </span>
              </button>

              {(m.teams?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(m.teams ?? []).slice(0, 4).map((t) => (
                    <span
                      key={t.id}
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary text-muted-foreground"
                    >
                      {t.name}
                    </span>
                  ))}
                  {(m.teams?.length ?? 0) > 4 && (
                    <span className="text-[10px] text-muted-foreground">
                      +{(m.teams?.length ?? 0) - 4}
                    </span>
                  )}
                </div>
              )}

              <div className="flex items-center gap-1.5 flex-wrap pt-1">
                {archivedView ? (
                  <button
                    type="button"
                    onClick={() => onUnarchive(m.id)}
                    className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors"
                  >
                    <ArchiveRestore className="h-3 w-3" />
                    Restore
                  </button>
                ) : (
                  <>
                    {m.kind !== 'client' && (
                      <button
                        type="button"
                        onClick={() => onSetRole(m.id, targetRole)}
                        disabled={isMe}
                        className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors disabled:opacity-40"
                      >
                        <UserCog className="h-3 w-3" />
                        Make {targetRole}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpen(m.id)}
                      className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors"
                    >
                      <UserCog className="h-3 w-3" />
                      Manage
                    </button>
                    <button
                      type="button"
                      onClick={() => onArchive(m.id)}
                      disabled={isMe}
                      className="tap ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-status-blocked hover:bg-status-blocked/10 transition-colors disabled:opacity-30"
                    >
                      <Archive className="h-3 w-3" />
                      Archive
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Desktop: real table with sortable column headers. */}
      <div className="hidden md:block rounded-lg border border-border bg-card/40 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/40 text-xs nockta-eyebrow text-muted-foreground">
              <th scope="col" className="px-4 py-2 text-left font-medium">
                <SortHeader
                  label="Member"
                  field="name"
                  sortField={sortField}
                  sortDir={sortDir}
                  onClick={onToggleSort}
                />
              </th>
              <th scope="col" className="px-2 py-2 text-left font-medium">Teams</th>
              <th scope="col" className="px-2 py-2 text-left font-medium">
                <SortHeader
                  label="Role"
                  field="role"
                  sortField={sortField}
                  sortDir={sortDir}
                  onClick={onToggleSort}
                />
              </th>
              <th scope="col" className="px-2 py-2 text-left font-medium">
                <SortHeader
                  label="Joined"
                  field="joined"
                  sortField={sortField}
                  sortDir={sortDir}
                  onClick={onToggleSort}
                />
              </th>
              <th scope="col" className="px-2 py-2 text-left font-medium">
                <SortHeader
                  label="Last seen"
                  field="lastSeen"
                  sortField={sortField}
                  sortDir={sortDir}
                  onClick={onToggleSort}
                />
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((m) => {
              const isMe = m.id === meId;
              const display = displayMember(m);
              const targetRole: CompanyRole = m.companyRole === 'Admin' ? 'Member' : 'Admin';
              return (
                <tr key={m.id} className="row-hover">
                  <td className="px-4 py-3 align-middle">
                    <button
                      type="button"
                      onClick={() => onOpen(m.id)}
                      className="flex items-center gap-3 text-left min-w-0 cursor-pointer w-full"
                    >
                      <AvatarCircle user={m} size={28} />
                      <span className="min-w-0">
                        <span className="text-sm font-medium truncate flex items-center gap-2">
                          <span
                            className={cn(display.muted && 'text-muted-foreground italic')}
                          >
                            {display.name}
                          </span>
                          {isMe && (
                            <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-px">
                              You
                            </span>
                          )}
                          {m.kind === 'client' && (
                            <span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-brand/15 text-brand font-semibold">
                              Client
                            </span>
                          )}
                          {display.imported && (
                            <span
                              className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-priority-high/15 text-priority-high font-semibold"
                              title={`Original ID: ${m.email}`}
                            >
                              Imported · Jira
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-muted-foreground truncate">
                          {display.secondary}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="px-2 py-3 align-middle">
                    <div className="flex flex-wrap gap-1 max-w-[220px]">
                      {(m.teams ?? []).slice(0, 3).map((t) => (
                        <span
                          key={t.id}
                          className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary text-muted-foreground"
                          title={`Team: ${t.name}`}
                        >
                          {t.name}
                        </span>
                      ))}
                      {(m.teams?.length ?? 0) > 3 && (
                        <span className="text-[10px] text-muted-foreground">
                          +{(m.teams?.length ?? 0) - 3}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-3 align-middle">
                    <span
                      className={cn(
                        'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md font-semibold',
                        m.companyRole === 'Admin'
                          ? 'bg-brand/15 text-brand'
                          : 'bg-secondary text-muted-foreground',
                      )}
                    >
                      {m.companyRole ?? (m.kind === 'client' ? 'Client' : 'Member')}
                    </span>
                  </td>
                  <td className="px-2 py-3 align-middle text-xs text-muted-foreground tabular-nums">
                    {m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-2 py-3 align-middle text-xs text-muted-foreground tabular-nums">
                    {m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 align-middle text-right">
                    <div className="inline-flex items-center gap-1">
                      {archivedView ? (
                        <button
                          type="button"
                          onClick={() => onUnarchive(m.id)}
                          className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors"
                          title="Restore account"
                        >
                          <ArchiveRestore className="h-3 w-3" />
                          Restore
                        </button>
                      ) : (
                        <>
                          {m.kind !== 'client' && (
                            <button
                              type="button"
                              onClick={() => onSetRole(m.id, targetRole)}
                              disabled={isMe}
                              className="tap inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              title={isMe ? "You can't change your own role" : `Make ${targetRole}`}
                            >
                              <UserCog className="h-3 w-3" />
                              {targetRole}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onOpen(m.id)}
                            className="tap inline-flex items-center justify-center rounded-md w-7 h-7 text-muted-foreground hover:bg-accent transition-colors"
                            title="Manage"
                            aria-label="Manage"
                          >
                            <UserCog className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onArchive(m.id)}
                            disabled={isMe}
                            className="tap inline-flex items-center justify-center rounded-md w-7 h-7 text-muted-foreground hover:bg-status-blocked/10 hover:text-status-blocked transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            title={isMe ? "You can't archive yourself" : 'Archive account'}
                            aria-label="Archive account"
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SortHeader({
  label,
  field,
  sortField,
  sortDir,
  onClick,
}: {
  label: string;
  field: SortField;
  sortField: SortField;
  sortDir: SortDir;
  onClick: (field: SortField) => void;
}): JSX.Element {
  const active = field === sortField;
  return (
    <button
      type="button"
      onClick={() => onClick(field)}
      className={cn(
        'inline-flex items-center gap-1 hover:text-foreground transition-colors',
        active && 'text-foreground',
      )}
      aria-label={`Sort by ${label}`}
    >
      {label}
      {active ? (
        sortDir === 'asc' ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        )
      ) : (
        <ChevronsUpDown className="h-3 w-3 opacity-40" />
      )}
    </button>
  );
}

/**
 * Resolve a member into clean display fields. Jira-imported placeholder users
 * (created by scripts/import-from-jira.ts when Jira didn't return a real email)
 * have `email = "<jiraAccountId>@jira-imported.local"` and often `name === email`.
 * We surface them as "Unknown user" + an "Imported · Jira" badge instead of
 * showing the raw placeholder twice.
 */
function displayMember(m: MemberUser): {
  name: string;
  secondary: string;
  imported: boolean;
  muted: boolean;
} {
  const imported = m.email.endsWith('@jira-imported.local');
  if (imported) {
    const nameLooksLikePlaceholder = !m.name || m.name === m.email;
    return {
      name: nameLooksLikePlaceholder ? 'Unknown user' : m.name!,
      secondary: 'Imported placeholder — no real email on file',
      imported: true,
      muted: nameLooksLikePlaceholder,
    };
  }
  return {
    name: m.name || m.email,
    secondary: m.email,
    imported: false,
    muted: false,
  };
}

// =============================================================================
// InviteGuestDialog — modal that POSTs to /users/invite-guest. Magic-link
// delivery is fire-and-forget on the server — the admin sees the row land in
// Clients immediately, the guest receives the email moments later.
// =============================================================================

function InviteGuestDialog({
  onClose,
  onInvited,
}: {
  onClose: () => void;
  onInvited: () => void;
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
      if (resp.alreadyExisted) {
        toast.success(`Re-sent magic link to ${resp.email}`);
      } else {
        toast.success(`Invited ${resp.email} — magic link sent`);
      }
      onInvited();
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
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-2xl"
      >
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-brand" />
            Invite a guest
          </h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            We'll email them a magic-link sign-in to the Nockta Flow app. They
            appear in the workspace user picker right away so you can grant
            project access before they sign in.
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
            {invite.isPending ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      </form>
    </div>
  );
}

// =============================================================================
// UserDrawer — full profile slideover with editable name/email, workspace
// standing toggle, team selector, per-project access grants, and archive.
// =============================================================================

function UserDrawer({
  userId,
  meId,
  teams,
  onClose,
}: {
  userId: string;
  meId: string | undefined;
  teams: Team[];
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ['user-detail', userId],
    queryFn: () => api.get<UserDetail>(`/users/${userId}`),
  });
  const detail = detailQuery.data;
  const [draftTeamIds, setDraftTeamIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (detail && draftTeamIds === null) {
      setDraftTeamIds(detail.teams.map((t) => t.id));
    }
  }, [detail, draftTeamIds]);

  const setTeams = useMutation({
    mutationFn: (teamIds: string[]) => api.put(`/users/${userId}/teams`, { teamIds }),
    onSuccess: () => {
      toast.success('Teams updated');
      void queryClient.invalidateQueries({ queryKey: ['user-detail', userId] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update teams')),
  });
  const setRole = useMutation({
    mutationFn: (role: CompanyRole) => api.patch(`/users/${userId}/role`, { role }),
    onSuccess: () => {
      toast.success('Role updated');
      void queryClient.invalidateQueries({ queryKey: ['user-detail', userId] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update role')),
  });
  const setKind = useMutation({
    mutationFn: (kind: 'internal' | 'client') =>
      api.patch(`/users/${userId}/kind`, { kind }),
    onSuccess: (_resp, kind) => {
      toast.success(kind === 'client' ? 'Converted to Guest' : 'Converted to internal');
      void queryClient.invalidateQueries({ queryKey: ['user-detail', userId] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not change kind')),
  });
  const archive = useMutation({
    mutationFn: () => api.delete(`/users/${userId}`),
    onSuccess: () => {
      toast.success('Account archived');
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      onClose();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not archive')),
  });
  const updateProfile = useMutation({
    mutationFn: (patch: { name?: string; email?: string }) =>
      api.patch<{ id: string; name: string; email: string }>(`/users/${userId}`, patch),
    onSuccess: (resp, vars) => {
      if (vars.email !== undefined) toast.success(`Email set to ${resp.email}`);
      else if (vars.name !== undefined) toast.success(`Renamed to ${resp.name}`);
      void queryClient.invalidateQueries({ queryKey: ['user-detail', userId] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not save')),
  });
  const unarchive = useMutation({
    mutationFn: () => api.post(`/users/${userId}/unarchive`, {}),
    onSuccess: () => {
      toast.success('Account restored');
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      void queryClient.invalidateQueries({ queryKey: ['user-detail', userId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not restore')),
  });

  const isMe = detail?.id === meId;
  const isClient = detail?.kind === 'client';
  const teamsDirty =
    draftTeamIds !== null &&
    detail !== undefined &&
    !sameSet(draftTeamIds, detail.teams.map((t) => t.id));

  // Esc-to-close + body scroll lock while the drawer is open.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex justify-end"
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-drawer-title"
        className="w-full max-w-xl h-full bg-card border-l border-border shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {!detail ? (
          <div className="p-6 space-y-3">
            <div className="flex items-center gap-3">
              <Spinner className="text-lg" />
              <span className="text-xs text-muted-foreground">Loading profile…</span>
            </div>
            <SkeletonList rows={4} rowClassName="h-8" />
          </div>
        ) : (
          <>
            <div className="px-6 py-5 border-b border-border flex items-start gap-4">
              <AvatarCircle user={detail} size={44} />
              <div className="flex-1 min-w-0">
                <div id="user-drawer-title" className="flex items-center gap-2 mb-0.5">
                  <EditableField
                    value={detail.name ?? ''}
                    placeholder="Add a name"
                    className="text-lg font-semibold truncate"
                    onSave={(name) => updateProfile.mutate({ name })}
                  />
                  {isMe && (
                    <span className="text-[10px] border border-border rounded px-1.5 py-px text-muted-foreground shrink-0">
                      You
                    </span>
                  )}
                  {detail.archivedAt && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-status-blocked/15 text-status-blocked font-semibold shrink-0">
                      Archived
                    </span>
                  )}
                </div>
                <EditableField
                  value={detail.email}
                  type="email"
                  placeholder="email@example.com"
                  className="text-xs text-muted-foreground"
                  onSave={(email) => updateProfile.mutate({ email })}
                />
                <div className="text-[11px] text-muted-foreground mt-1">
                  {isClient ? 'Client' : detail.companyRole ?? 'Member'} ·
                  joined {new Date(detail.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground text-2xl leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="px-6 py-5 space-y-6">
              <section>
                <SectionTitle
                  title="Workspace standing"
                  hint={
                    isMe
                      ? "Can't change your own standing."
                      : 'Admins see everything. Members are internal teammates. Guests use the client portal.'
                  }
                />
                <div className="mt-3 inline-flex rounded-md border border-border bg-background/60 p-0.5">
                  {(
                    [
                      { value: 'Admin' as const, label: 'Admin' },
                      { value: 'Member' as const, label: 'Member' },
                      { value: 'Guest' as const, label: 'Guest' },
                    ]
                  ).map((opt) => {
                    const active = isClient
                      ? opt.value === 'Guest'
                      : detail.companyRole === opt.value;
                    const pending = setRole.isPending || setKind.isPending;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={isMe || active || pending}
                        onClick={() => {
                          if (active) return;
                          if (opt.value === 'Guest') {
                            if (
                              window.confirm(
                                `Convert ${detail.email} to a Guest? They'll lose internal access and team memberships, and will sign in via the client portal.`,
                              )
                            ) {
                              setKind.mutate('client');
                            }
                          } else {
                            // Admin or Member — backend auto-promotes a client.
                            setRole.mutate(opt.value);
                          }
                        }}
                        className={cn(
                          'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                          active
                            ? opt.value === 'Guest'
                              ? 'bg-priority-medium/15 text-priority-medium shadow-sm'
                              : 'bg-brand/10 text-brand shadow-sm'
                            : 'text-muted-foreground hover:text-foreground hover:bg-accent',
                          (isMe || pending) && !active && 'opacity-40 cursor-not-allowed',
                        )}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                {isClient && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Guest accounts see only projects you grant them explicitly.
                    To grant access, open a project and add them under Settings → Access.
                  </p>
                )}
              </section>

              {!isClient && (
                <section>
                  <div className="flex items-baseline justify-between">
                    <SectionTitle title="Teams" hint="Used for filtering and access grants." />
                    {teamsDirty && draftTeamIds && (
                      <button
                        type="button"
                        onClick={() => setTeams.mutate(draftTeamIds)}
                        disabled={setTeams.isPending}
                        className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                      >
                        {setTeams.isPending ? 'Saving…' : 'Save changes'}
                      </button>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {teams.length === 0 && (
                      <div className="text-xs text-muted-foreground italic">
                        No teams in the workspace yet. Create one in the Teams tab.
                      </div>
                    )}
                    {teams.map((t) => {
                      const selected = draftTeamIds?.includes(t.id) ?? false;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setDraftTeamIds((prev) => {
                              if (prev === null) return [t.id];
                              return selected
                                ? prev.filter((id) => id !== t.id)
                                : [...prev, t.id];
                            });
                          }}
                          className={cn(
                            'text-xs px-2.5 py-1 rounded-full border transition-colors',
                            selected
                              ? 'border-brand bg-brand/15 text-brand'
                              : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30',
                          )}
                          title={t.description ?? undefined}
                        >
                          {t.name}
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              <UserProjectAccess
                userId={userId}
                userKind={detail.kind}
                grants={detail.projects}
              />

              <section className="pt-2 border-t border-border">
                <SectionTitle title="Danger zone" hint="" />
                {detail.archivedAt ? (
                  <button
                    type="button"
                    onClick={() => unarchive.mutate()}
                    disabled={unarchive.isPending}
                    className="mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-1.5 text-xs hover:bg-accent transition-colors disabled:opacity-50"
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" />
                    Restore account
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isMe || archive.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          'Archive this account? They will be signed out immediately.',
                        )
                      ) {
                        archive.mutate();
                      }
                    }}
                    className="mt-3 inline-flex items-center gap-2 rounded-md border border-status-blocked/40 bg-status-blocked/10 px-3 py-1.5 text-xs text-status-blocked hover:bg-status-blocked/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    {archive.isPending ? 'Archiving…' : 'Archive account'}
                  </button>
                )}
              </section>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

// =============================================================================
// UserProjectAccess — inline editor for project grants on a single user.
//
// Lists every project the user has access to (with role badge + source) and
// adds an "Add project" form at the bottom. Revoke shows only when the grant
// is a direct user grant — team-derived and public-visibility grants can't
// be revoked from this UI.
// =============================================================================

function UserProjectAccess({
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
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectOption[]>('/projects'),
  });
  const allProjects = projectsQuery.data ?? [];
  const grantedProjectIds = new Set(grants.map((g) => g.id));
  const candidates = allProjects.filter((p) => !grantedProjectIds.has(p.id));

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['user-detail', userId] });
    void queryClient.invalidateQueries({ queryKey: ['members'] });
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
            ? 'Pick which projects this guest can see in the client portal.'
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
                {userKind === 'client' ? (
                  <option value="Client">Client</option>
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
  const [role, setRole] = useState<'Manager' | 'Contributor' | 'Viewer' | 'Client'>(
    userKind === 'client' ? 'Client' : 'Contributor',
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
        disabled={userKind === 'client'}
        className="rounded-md border border-input bg-background px-2 py-1.5 text-xs disabled:opacity-60"
        title={
          userKind === 'client'
            ? 'Guests can only have the Client role.'
            : 'Pick a role'
        }
        aria-label="Role"
      >
        {userKind === 'client' ? (
          <option value="Client">Client</option>
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

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}
