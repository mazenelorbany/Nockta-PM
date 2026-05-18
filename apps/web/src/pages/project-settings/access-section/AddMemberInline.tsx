import { useState } from 'react';

import type { AccessUserOption, ProjectRole } from '../types';

// AddMemberInline — pick an internal user + role, hit Add.
export function AddMemberInline({
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
