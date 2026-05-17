import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Trash2, UserPlus } from 'lucide-react';
import { Spinner, SkeletonList, cn } from '@nockta/ui';
import { api } from '../../lib/api';
import { AvatarCircle } from '../task-bits';
import { AdminGate, SectionTitle, apiErrorMessage } from './primitives';

// =============================================================================
// WorkspaceMembersTab — Settings → Workspace.
//
// Lists members of the authenticated user's workspace (resolved server-side
// from /workspace/current), lets an Admin/Owner add, role-change, and
// remove members. Wired to the new /workspace/members endpoints introduced
// in Round 6 Pass A (multi-tenant boundary lift).
//
// Distinct from MembersTab: that surface manages the global user list
// (internal users, clients, archives). THIS surface manages who's a member
// of the active workspace and what their workspace-scoped role is — Owner,
// Admin, or Member. The two will fully diverge once the platform supports
// multiple workspaces per user; for now they describe the same population
// but with different role semantics.
// =============================================================================

const WORKSPACE_ROLES = ['Owner', 'Admin', 'Member'] as const;
type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

interface WorkspaceCurrent {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
}

interface MemberRow {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    kind: 'internal' | 'client';
    companyRole: 'Admin' | 'Member' | null;
  };
}

interface CandidateUser {
  id: string;
  email: string;
  name?: string;
}

export function WorkspaceMembersTab({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  if (!isAdmin) return <AdminGate />;
  return <WorkspaceMembersAdmin />;
}

function WorkspaceMembersAdmin(): JSX.Element {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState<WorkspaceRole>('Member');

  const currentQuery = useQuery({
    queryKey: ['workspace', 'current'],
    queryFn: () => api.get<WorkspaceCurrent>('/workspace/current'),
  });

  const membersQuery = useQuery({
    queryKey: ['workspace', 'members'],
    queryFn: () => api.get<MemberRow[]>('/workspace/members'),
  });

  // Used to look up a user id by email when the Admin adds a member.
  // We piggy-back on the existing /users list (used by MembersTab) since
  // a dedicated email-search endpoint is out of scope for this pass. The
  // endpoint returns `{ items, nextCursor }`; we only need the first page
  // here since the form is a freeform email field — the dropdown isn't
  // rendered.
  const usersQuery = useQuery({
    queryKey: ['users', 'all-for-workspace-add'],
    queryFn: () =>
      api.get<{ items: CandidateUser[]; nextCursor: string | null }>('/users?limit=100'),
    enabled: adding,
  });

  const addMember = useMutation({
    mutationFn: (input: { userId: string; role: WorkspaceRole }) =>
      api.post<MemberRow>('/workspace/members', input),
    onSuccess: () => {
      toast.success(t('settings.workspace.member_added', 'Member added'));
      setAdding(false);
      setAddEmail('');
      setAddRole('Member');
      void qc.invalidateQueries({ queryKey: ['workspace', 'members'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not add member')),
  });

  const updateRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: WorkspaceRole }) =>
      api.patch<MemberRow>(`/workspace/members/${userId}`, { role }),
    onSuccess: () => {
      toast.success(t('settings.workspace.role_updated', 'Role updated'));
      void qc.invalidateQueries({ queryKey: ['workspace', 'members'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update role')),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      api.delete<{ removed: boolean }>(`/workspace/members/${userId}`),
    onSuccess: () => {
      toast.success(t('settings.workspace.member_removed', 'Member removed'));
      void qc.invalidateQueries({ queryKey: ['workspace', 'members'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not remove member')),
  });

  const onAddSubmit = (): void => {
    const trimmed = addEmail.trim().toLowerCase();
    if (!trimmed) return;
    const match = (usersQuery.data?.items ?? []).find((u) => u.email.toLowerCase() === trimmed);
    if (!match) {
      toast.error(t('settings.workspace.user_not_found', 'No user with that email — invite them first'));
      return;
    }
    addMember.mutate({ userId: match.id, role: addRole });
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 space-y-6 max-w-4xl">
      <SectionTitle
        title={t('settings.workspace.title', 'Workspace')}
        hint={t(
          'settings.workspace.hint',
          'Manage who belongs to this workspace and what they can do.',
        )}
      />

      {currentQuery.data && (
        <div className="rounded-md border border-border p-4 bg-card">
          <div className="text-xs text-muted-foreground">
            {t('settings.workspace.current_label', 'Current workspace')}
          </div>
          <div className="text-base font-medium mt-0.5">{currentQuery.data.name}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {t('settings.workspace.your_role', 'Your role')}: {currentQuery.data.role}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          {t('settings.workspace.members_heading', 'Members')}
        </h3>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <UserPlus className="size-3.5" />
          {t('settings.workspace.add_member', 'Add member')}
        </button>
      </div>

      {adding && (
        <div className="rounded-md border border-border p-3 bg-card space-y-2">
          <div className="text-xs text-muted-foreground">
            {t(
              'settings.workspace.add_hint',
              'Enter the email of an existing user. To onboard a brand-new account, invite them first under Members.',
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="email"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              placeholder={t('settings.workspace.email_placeholder', 'name@nockta.com')}
              className="flex-1 px-2 py-1 rounded-md border border-input bg-background text-sm"
            />
            <select
              value={addRole}
              onChange={(e) => setAddRole(e.target.value as WorkspaceRole)}
              className="px-2 py-1 rounded-md border border-input bg-background text-sm"
            >
              {WORKSPACE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onAddSubmit}
              disabled={addMember.isPending}
              className="inline-flex items-center justify-center px-3 py-1 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50"
            >
              {addMember.isPending ? <Spinner className="size-3.5" /> : t('common.add', 'Add')}
            </button>
          </div>
        </div>
      )}

      {membersQuery.isLoading ? (
        <SkeletonList rows={4} />
      ) : (
        <div className="rounded-md border border-border divide-y divide-border bg-card">
          {(membersQuery.data ?? []).map((m) => (
            <MemberRowView
              key={m.userId}
              row={m}
              currentRole={currentQuery.data?.role ?? 'Member'}
              onChangeRole={(role) => updateRole.mutate({ userId: m.userId, role })}
              onRemove={() => removeMember.mutate(m.userId)}
              busy={
                (updateRole.isPending && updateRole.variables?.userId === m.userId) ||
                (removeMember.isPending && removeMember.variables === m.userId)
              }
            />
          ))}
          {membersQuery.data?.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t('settings.workspace.empty', 'No members yet — add one above.')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MemberRowView({
  row,
  currentRole,
  onChangeRole,
  onRemove,
  busy,
}: {
  row: MemberRow;
  currentRole: WorkspaceRole;
  onChangeRole: (role: WorkspaceRole) => void;
  onRemove: () => void;
  busy: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const canMutate = currentRole === 'Owner' || currentRole === 'Admin';
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <AvatarCircle
        user={{
          id: row.user.id,
          name: row.user.name,
          email: row.user.email,
          avatarUrl: row.user.avatarUrl,
        }}
        size={28}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{row.user.name || row.user.email}</div>
        <div className="text-xs text-muted-foreground truncate">{row.user.email}</div>
      </div>
      <select
        value={row.role}
        onChange={(e) => onChangeRole(e.target.value as WorkspaceRole)}
        disabled={!canMutate || busy}
        className={cn(
          'px-2 py-1 rounded-md border border-input bg-background text-xs',
          (!canMutate || busy) && 'opacity-60 cursor-not-allowed',
        )}
      >
        {WORKSPACE_ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onRemove}
        disabled={!canMutate || busy}
        title={t('settings.workspace.remove_member', 'Remove member')}
        className={cn(
          'p-1.5 rounded-md hover:bg-destructive/10 text-destructive',
          (!canMutate || busy) && 'opacity-40 cursor-not-allowed',
        )}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
