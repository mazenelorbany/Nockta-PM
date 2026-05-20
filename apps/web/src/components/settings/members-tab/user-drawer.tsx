import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Archive, ArchiveRestore } from 'lucide-react';
import { SkeletonList, Spinner, cn } from '@nockta/ui';

import { api } from '../../../lib/api';
import { AvatarCircle } from '../../task-bits';
import { EditableField, SectionTitle, apiErrorMessage } from '../primitives';
import type { Team } from '../TeamsTab';
import { queryKeys } from '../../../lib/query-keys';

import type { CompanyRole, UserDetail } from './types';
import { UserProjectAccess } from './user-project-access';

// =============================================================================
// UserDrawer — full profile slideover with editable name/email, workspace
// standing toggle, team selector, per-project access grants, and archive.
// =============================================================================

export function UserDrawer({
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.members() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.teams() });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update teams')),
  });
  const setRole = useMutation({
    mutationFn: (role: CompanyRole) => api.patch(`/users/${userId}/role`, { role }),
    onSuccess: () => {
      toast.success('Role updated');
      void queryClient.invalidateQueries({ queryKey: ['user-detail', userId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.members() });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update role')),
  });
  const setKind = useMutation({
    mutationFn: (kind: 'internal' | 'client') =>
      api.patch(`/users/${userId}/kind`, { kind }),
    onSuccess: (_resp, kind) => {
      toast.success(kind === 'client' ? 'Converted to External' : 'Converted to internal');
      void queryClient.invalidateQueries({ queryKey: ['user-detail', userId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.members() });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not change kind')),
  });
  const archive = useMutation({
    mutationFn: () => api.delete(`/users/${userId}`),
    onSuccess: () => {
      toast.success('Account archived');
      void queryClient.invalidateQueries({ queryKey: queryKeys.members() });
      onClose();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not archive')),
  });
  const updateProfile = useMutation({
    mutationFn: (patch: { name?: string; email?: string }) =>
      api.patch<{ id: string; name: string; email: string }>(`/users/${userId}`, patch),
    onSuccess: (resp, vars) => {
      if (vars.email !== undefined) {
        // The previous copy was "Email set to X" — close enough to "Email
        // sent to X" that more than one admin assumed a notification went
        // out. Be explicit: this endpoint only updates the row, it does
        // not message the user. For an external user that means their next
        // magic link needs to be re-issued manually from the invite flow.
        toast.success(`Email updated to ${resp.email}. The user was not notified.`);
      } else if (vars.name !== undefined) {
        toast.success(`Renamed to ${resp.name}`);
      }
      void queryClient.invalidateQueries({ queryKey: ['user-detail', userId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.members() });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not save')),
  });
  const unarchive = useMutation({
    mutationFn: () => api.post(`/users/${userId}/unarchive`, {}),
    onSuccess: () => {
      toast.success('Account restored');
      void queryClient.invalidateQueries({ queryKey: queryKeys.members() });
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
                  {isClient ? 'External' : detail.companyRole ?? 'Member'} ·
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
                      : 'Admins see everything. Members are internal teammates. External users sign in via magic link and only see what you grant them.'
                  }
                />
                <div className="mt-3 inline-flex rounded-md border border-border bg-background/60 p-0.5">
                  {(
                    [
                      { value: 'Admin' as const, label: 'Admin' },
                      { value: 'Member' as const, label: 'Member' },
                      // Internal identifier kept as 'Guest' so the click
                      // handler below (which maps it to setKind('client'))
                      // doesn't need rewriting — only the visible label
                      // changes to match the External rename.
                      { value: 'Guest' as const, label: 'External' },
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
                                `Convert ${detail.email} to an external user? They'll lose internal access and team memberships, and will sign in via magic link.`,
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
                    External users see only projects you grant them explicitly.
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

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}
