import { Link } from 'react-router-dom';
import { cn } from '@nockta/ui';
import { AvatarCircle } from '../../components/task-bits';
import { GoalStatusPill } from './GoalStatusPill';
import type { GoalListItem } from './types';

export function GoalCard({ goal }: { goal: GoalListItem }): JSX.Element {
  const pct = goal.progress ?? 0;
  return (
    <Link
      to={`/goals/${goal.id}`}
      className="block rounded-lg border border-border bg-card p-5 hover:border-ring transition-colors"
    >
      <div className="flex items-center justify-between mb-2">
        <GoalStatusPill status={goal.status} />
        <span className="text-xs text-muted-foreground">
          {goal._count.tasks} task{goal._count.tasks === 1 ? '' : 's'}
        </span>
      </div>
      <h3 className="text-base font-semibold tracking-tight">{goal.name}</h3>
      {goal.description && (
        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{goal.description}</p>
      )}
      <div className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="nockta-eyebrow text-muted-foreground">Progress</span>
          <span className="font-medium tabular-nums">{pct}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              'h-full transition-all',
              goal.status === 'achieved' ? 'bg-status-done' : 'bg-brand',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <AvatarCircle user={goal.owner} size={18} />
          {goal.owner.name}
        </span>
        {goal.targetDate && (
          <span>Target {new Date(goal.targetDate).toLocaleDateString()}</span>
        )}
      </div>
    </Link>
  );
}
