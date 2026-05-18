import { Users } from 'lucide-react';
import { cn } from '@nockta/ui';

import { AvatarCircle } from '../../components/task-bits';

// =============================================================================
// SprintCapacityBar — rolled-up stats above the Sprint pane.
// =============================================================================

export function SprintCapacityBar({
  count,
  points,
  unassignedCount,
  unassignedPoints,
  byAssignee,
}: {
  count: number;
  points: number;
  unassignedCount: number;
  unassignedPoints: number;
  byAssignee: { id: string; name: string; avatarUrl?: string | null; count: number; points: number }[];
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 text-xs flex-wrap">
      <div className="flex items-center gap-4">
        <Stat label="Tasks" value={count} />
        <Stat label="Points" value={points} />
        {unassignedCount > 0 && (
          <Stat label="Unassigned" value={`${unassignedCount} · ${unassignedPoints} pts`} tone="warning" />
        )}
      </div>
      {byAssignee.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <Users className="h-3 w-3 text-muted-foreground" />
          {byAssignee.slice(0, 6).map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 rounded-full bg-secondary/60 px-2 py-0.5"
              title={`${a.name}: ${a.count} tasks${a.points ? ` · ${a.points} pts` : ''}`}
            >
              <AvatarCircle user={{ id: a.id, name: a.name, avatarUrl: a.avatarUrl ?? null }} size={14} />
              <span className="text-[10px] font-medium">{a.count}</span>
              {a.points > 0 && <span className="text-[10px] text-muted-foreground">· {a.points}</span>}
            </span>
          ))}
          {byAssignee.length > 6 && (
            <span className="text-[10px] text-muted-foreground">+{byAssignee.length - 6} more</span>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'warning' }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="nockta-eyebrow text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-semibold tabular-nums',
          tone === 'warning' && 'text-priority-high'
        )}
      >
        {value}
      </span>
    </span>
  );
}
