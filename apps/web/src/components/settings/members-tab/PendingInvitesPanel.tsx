import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, RotateCw, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { SkeletonList } from '@nockta/ui';

import { api } from '../../../lib/api';
import { formatRelative } from '../../task-detail/utils';
import { apiErrorMessage } from '../primitives';

// =============================================================================
// PendingInvitesPanel — every project_invite magic-link the admin sent that
// the guest hasn't clicked yet. Backed by `GET /users/pending-invites`.
//
// Each row carries an inviter, project, role, and the relative time the
// invite was sent / will expire. Two actions: re-send (issues a fresh link,
// invalidates the prior one) and revoke (expires the link + drops the
// pre-created ProjectAccess so the guest no longer has access to the
// project either).
// =============================================================================

interface PendingInvite {
  id: string;
  email: string;
  invitee: { id: string; name: string; kind: 'internal' | 'client' } | null;
  project: { id: string; name: string; key: string } | null;
  invitedBy: { id: string; name: string; email: string } | null;
  role: string | null;
  invitedAt: string;
  expiresAt: string;
}

export function PendingInvitesPanel(): JSX.Element {
  const queryClient = useQueryClient();

  const invitesQuery = useQuery({
    queryKey: ['pending-invites'],
    queryFn: () => api.get<PendingInvite[]>('/users/pending-invites'),
  });

  const resend = useMutation({
    mutationFn: (linkId: string) => api.post(`/users/pending-invites/${linkId}/resend`),
    onSuccess: () => {
      toast.success('Invitation re-sent');
      void queryClient.invalidateQueries({ queryKey: ['pending-invites'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Re-send failed')),
  });

  const revoke = useMutation({
    mutationFn: (linkId: string) => api.delete(`/users/pending-invites/${linkId}`),
    onSuccess: () => {
      toast.success('Invitation revoked');
      void queryClient.invalidateQueries({ queryKey: ['pending-invites'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Revoke failed')),
  });

  if (invitesQuery.isLoading) {
    return <SkeletonList rows={4} rowClassName="h-14" />;
  }

  const items = invitesQuery.data ?? [];
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border p-8 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-brand/10 text-brand">
          <Mail className="h-4 w-4" />
        </div>
        <p className="text-sm font-medium">No pending invitations</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Anyone you invite to a project will appear here until they accept the link.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-card/40 text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Invitee</th>
            <th className="px-3 py-2 text-left font-medium">Project</th>
            <th className="px-3 py-2 text-left font-medium">Role</th>
            <th className="px-3 py-2 text-left font-medium">Inviter</th>
            <th className="px-3 py-2 text-left font-medium">Sent</th>
            <th className="px-3 py-2 text-left font-medium">Expires</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((inv) => {
            const expired = new Date(inv.expiresAt).getTime() < Date.now();
            return (
              <tr key={inv.id} className="border-t border-border hover:bg-accent/30">
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{inv.email}</div>
                  {inv.invitee && (
                    <div className="text-[10px] text-muted-foreground">
                      Account: {inv.invitee.name}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {inv.project ? (
                    <Link
                      to={`/projects/${inv.project.id}/board`}
                      className="text-foreground hover:text-brand underline-offset-2 hover:underline"
                    >
                      {inv.project.key}{' '}
                      <span className="text-muted-foreground">— {inv.project.name}</span>
                    </Link>
                  ) : (
                    <span className="text-muted-foreground italic">project deleted</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {inv.role ? (
                    <span className="inline-flex items-center rounded-md border border-border bg-card/30 px-2 py-0.5 text-[10px] font-medium">
                      {inv.role}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {inv.invitedBy?.name ?? inv.invitedBy?.email ?? '—'}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{formatRelative(inv.invitedAt)}</td>
                <td
                  className={`px-3 py-2 ${
                    expired ? 'text-destructive' : 'text-muted-foreground'
                  }`}
                >
                  {expired ? 'expired' : formatRelative(inv.expiresAt)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => resend.mutate(inv.id)}
                      disabled={resend.isPending}
                      className="tap inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-50"
                      title="Issue a fresh link and email it again"
                    >
                      <RotateCw className="h-3 w-3" />
                      Re-send
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Revoke ${inv.email}'s invitation? Their project access will be removed.`,
                          )
                        ) {
                          revoke.mutate(inv.id);
                        }
                      }}
                      disabled={revoke.isPending}
                      className="tap inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      title="Expire the link and revoke project access"
                    >
                      <X className="h-3 w-3" />
                      Revoke
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
