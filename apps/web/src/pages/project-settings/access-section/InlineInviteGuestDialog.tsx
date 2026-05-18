import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { UserPlus } from 'lucide-react';

import { api } from '../../../lib/api';
import { apiErrorMessage } from '../utils';

// InlineInviteGuestDialog — slim local version of the workspace-level
// InviteGuestDialog. Lives inline here so a Manager can spin up a brand-new
// guest and grant them access to this project without leaving Settings.
export function InlineInviteGuestDialog({
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
