import { useState } from 'react';
import { ArrowRight } from 'lucide-react';

import type { AccessUserOption, ProjectRole } from '../types';

// AddGuestInline — pick an existing external user, choose a role (Viewer /
// Contributor / Manager), and grant access; or jump to the invite dialog
// if the right person isn't in the list yet. The role picker is what
// surfaced the gap the user flagged — previously externals were silently
// hard-coded to the legacy Client role.
export function AddGuestInline({
  clientUsers,
  pending,
  onSubmit,
  onInvite,
}: {
  clientUsers: AccessUserOption[];
  pending: boolean;
  onSubmit: (userId: string, role: ProjectRole) => void;
  onInvite: () => void;
}): JSX.Element {
  const [userId, setUserId] = useState('');
  // Default to Viewer — read-only is the safer default for the
  // "share this project with a collaborator" case.
  const [role, setRole] = useState<ProjectRole>('Viewer');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!userId) return;
        onSubmit(userId, role);
        setUserId('');
      }}
      className="flex flex-wrap items-center gap-2 px-3 py-2 bg-background/40 border-t border-border"
    >
      <select
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        className="flex-1 min-w-[180px] rounded-md border border-input bg-background px-2 py-1.5 text-xs"
        aria-label="External user"
      >
        <option value="">
          {clientUsers.length === 0
            ? 'No external users in the workspace yet — invite one →'
            : 'Pick an existing external user…'}
        </option>
        {clientUsers.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name || u.email}
          </option>
        ))}
      </select>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as ProjectRole)}
        className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
        aria-label="Role"
      >
        <option value="Viewer">Viewer (read)</option>
        <option value="Contributor">Contributor (write)</option>
        <option value="Manager">Manager</option>
      </select>
      <button
        type="submit"
        disabled={!userId || pending}
        className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        Add
      </button>
      <span className="text-muted-foreground/70 text-xs">or</span>
      <button
        type="button"
        onClick={onInvite}
        className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
      >
        Invite new external user by email
        <ArrowRight className="h-3 w-3" />
      </button>
    </form>
  );
}
