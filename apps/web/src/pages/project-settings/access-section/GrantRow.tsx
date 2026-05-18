import { X } from 'lucide-react';
import { cn } from '@nockta/ui';

import { ROLE_HINTS } from '../constants';
import type { ProjectRole } from '../types';

// GrantRow — one access row with avatar, role select, revoke button.
export function GrantRow({
  avatar,
  primary,
  secondary,
  badge,
  currentRole,
  availableRoles,
  onRoleChange,
  onRevoke,
}: {
  avatar: React.ReactNode;
  primary: string;
  secondary?: string | undefined;
  badge?: { label: string; tone: 'brand' | 'guest' } | undefined;
  currentRole: ProjectRole;
  availableRoles: ProjectRole[];
  onRoleChange: (role: ProjectRole) => void;
  onRevoke: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3 px-3 py-2 border-b border-border last:border-b-0 hover:bg-accent/20 transition-colors">
      <div className="shrink-0">{avatar}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium truncate">{primary}</span>
          {badge && (
            <span
              className={cn(
                'text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold shrink-0',
                badge.tone === 'brand'
                  ? 'bg-brand/15 text-brand'
                  : 'bg-priority-medium/15 text-priority-medium',
              )}
            >
              {badge.label}
            </span>
          )}
        </div>
        {secondary && (
          <div className="text-[11px] text-muted-foreground truncate">{secondary}</div>
        )}
      </div>
      <select
        value={currentRole}
        onChange={(e) => onRoleChange(e.target.value as ProjectRole)}
        disabled={availableRoles.length === 1}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs disabled:opacity-60 disabled:cursor-not-allowed"
        title={ROLE_HINTS[currentRole]}
      >
        {availableRoles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onRevoke}
        className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
        aria-label="Revoke access"
        title="Revoke"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
