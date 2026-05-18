import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, UserPlus, Users as UsersIcon } from 'lucide-react';
import { SkeletonList, cn } from '@nockta/ui';

import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-store';
import { queryKeys } from '../../lib/query-keys';

import {
  AdminGate,
  HelpHint,
  SectionTitle,
  apiErrorMessage,
} from './primitives';
import type { Team } from './TeamsTab';
import { InviteGuestDialog } from './members-tab/invite-guest-dialog';
import { PeopleTable } from './members-tab/people-table';
import type {
  CompanyRole,
  KindFilter,
  MemberUser,
  SortDir,
  SortField,
} from './members-tab/types';
import { UserDrawer } from './members-tab/user-drawer';

// =============================================================================
// MembersTab — the "people" tab. Lists internal members, clients, and archived
// accounts; lets an Admin search, filter by team, sort, change role, archive,
// and open a per-user drawer for deeper edits (teams + project access).
// =============================================================================

export function MembersTab({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const { user: me } = useAuth();
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
    queryKey: queryKeys.teams(),
    queryFn: () => api.get<Team[]>('/teams'),
    enabled: isAdmin,
  });

  const setRole = useMutation({
    mutationFn: (input: { id: string; role: CompanyRole }) =>
      api.patch(`/users/${input.id}/role`, { role: input.role }),
    onSuccess: () => {
      toast.success('Role updated');
      void queryClient.invalidateQueries({ queryKey: queryKeys.members() });
      void queryClient.invalidateQueries({ queryKey: ['user-detail'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update role')),
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.delete(`/users/${id}`),
    onSuccess: () => {
      toast.success('Member archived');
      void queryClient.invalidateQueries({ queryKey: queryKeys.members() });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not archive member')),
  });
  const unarchive = useMutation({
    mutationFn: (id: string) => api.post(`/users/${id}/unarchive`, {}),
    onSuccess: () => {
      toast.success('Member restored');
      void queryClient.invalidateQueries({ queryKey: queryKeys.members() });
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
        <SectionTitle title={'People'} hint={headerHint} />
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 sm:flex-initial min-w-0">
            <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={'Search by name or email…'}
              className="field text-xs py-1.5 ps-8 w-full sm:w-64"
              aria-label={'Search'}
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
            void queryClient.invalidateQueries({ queryKey: queryKeys.members() });
            setKind('client');
            setInviteOpen(false);
          }}
        />
      )}
    </div>
  );
}
