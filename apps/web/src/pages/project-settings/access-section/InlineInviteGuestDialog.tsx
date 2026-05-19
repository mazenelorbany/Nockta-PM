import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { UserPlus } from 'lucide-react';

import { api } from '../../../lib/api';
import type { ProjectRole } from '../types';
import { apiErrorMessage } from '../utils';

// =============================================================================
// InlineInviteGuestDialog — invite an external collaborator to THIS project.
//
// Calls `POST /projects/:projectId/invite-guest` which atomically:
//   1. Creates (or fetches) the guest User row (kind='client'),
//   2. Grants ProjectAccess at the picked role,
//   3. Emails a 7-day invitation link naming the inviter + the project.
//
// One round-trip — the old two-step ("invite guest" → "grant access") had a
// race window where step 2 could fail and leave the user invited but
// project-less.
// =============================================================================

interface InvitePayload {
  userId: string;
  email: string;
  name: string;
  projectId: string;
  role: ProjectRole;
  grantId: string;
  invitedAt: string;
}

// Roles a guest can hold. The 'Client' default matches the most common
// "external stakeholder" case — Manager / Contributor / Viewer are for the
// less-frequent agency-or-vendor flow.
const ROLE_OPTIONS: Array<{ value: ProjectRole; label: string; hint: string }> = [
  { value: 'Client', label: 'Client', hint: 'Read-only on tasks, can file bugs and read docs.' },
  { value: 'Viewer', label: 'Viewer', hint: 'Read-only across the whole project.' },
  { value: 'Contributor', label: 'Contributor', hint: 'Can create + edit tasks, can\'t grant access.' },
  { value: 'Manager', label: 'Manager', hint: 'Full control of the project (invites, settings, danger zone).' },
];

export function InlineInviteGuestDialog({
  projectId,
  onClose,
  onInvited,
}: {
  projectId: string;
  onClose: () => void;
  onInvited: (resp: InvitePayload) => void;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<ProjectRole>('Client');

  const invite = useMutation({
    mutationFn: () =>
      api.post<InvitePayload>(`/projects/${projectId}/invite-guest`, {
        email: email.trim().toLowerCase(),
        ...(name.trim() ? { name: name.trim() } : {}),
        role,
      }),
    onSuccess: (resp) => {
      toast.success(`Invited ${resp.email} as ${resp.role}`);
      onInvited(resp);
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
            We'll email them a 7-day sign-in link and grant them the role you
            pick below. Internal teammates (on the company domain) sign in
            via Google OAuth — they don't need to be invited.
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
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">
              Role on this project
            </label>
            <div className="grid grid-cols-1 gap-1.5">
              {ROLE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                    role === opt.value
                      ? 'border-brand bg-brand/5'
                      : 'border-input hover:bg-accent'
                  }`}
                >
                  <input
                    type="radio"
                    name="role"
                    value={opt.value}
                    checked={role === opt.value}
                    onChange={() => setRole(opt.value)}
                    className="mt-0.5"
                  />
                  <span className="flex-1">
                    <span className="block text-sm font-medium">{opt.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </div>
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
            {invite.isPending ? 'Sending…' : `Invite as ${role}`}
          </button>
        </div>
      </form>
    </div>
  );
}
