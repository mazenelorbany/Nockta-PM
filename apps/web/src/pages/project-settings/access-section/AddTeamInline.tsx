import { useState } from 'react';

import type { AccessTeamOption, ProjectRole } from '../types';

// AddTeamInline — pick a team + role.
export function AddTeamInline({
  availableTeams,
  pending,
  onSubmit,
}: {
  availableTeams: AccessTeamOption[];
  pending: boolean;
  onSubmit: (teamId: string, role: ProjectRole) => void;
}): JSX.Element {
  const [teamId, setTeamId] = useState('');
  const [role, setRole] = useState<ProjectRole>('Contributor');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!teamId) return;
        onSubmit(teamId, role);
        setTeamId('');
        setRole('Contributor');
      }}
      className="flex flex-wrap items-center gap-2 px-3 py-2 bg-background/40 border-t border-border"
    >
      <select
        value={teamId}
        onChange={(e) => setTeamId(e.target.value)}
        className="flex-1 min-w-[180px] rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="">Pick a team…</option>
        {availableTeams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
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
        disabled={!teamId || pending}
        className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        Add team
      </button>
    </form>
  );
}
