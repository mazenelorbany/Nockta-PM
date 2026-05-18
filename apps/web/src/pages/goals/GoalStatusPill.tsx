import { cn } from '@nockta/ui';

import type { GoalStatus } from './types';

export function GoalStatusPill({ status }: { status: GoalStatus }): JSX.Element {
  const tone =
    status === 'active'   ? 'bg-status-in-progress/20 text-status-in-progress' :
    status === 'achieved' ? 'bg-status-done/20 text-status-done' :
                            'bg-status-todo/15 text-status-todo';
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide',
        tone,
      )}
    >
      {status}
    </span>
  );
}
