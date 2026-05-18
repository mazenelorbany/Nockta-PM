import { useQuery } from '@tanstack/react-query';
import { Target } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@nockta/ui';

import { api } from '../../lib/api';

import { CreateGoalDialog } from './CreateGoalDialog';
import { EmptyState } from './EmptyState';
import { GoalCard } from './GoalCard';
import type { GoalListItem, GoalStatus } from './types';

export function GoalListView(): JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [statusTab, setStatusTab] = useState<GoalStatus | 'all'>('active');

  const goalsQuery = useQuery({
    queryKey: ['goals', statusTab],
    queryFn: () =>
      api.get<GoalListItem[]>(
        statusTab === 'all' ? '/goals' : `/goals?status=${statusTab}`,
      ),
  });

  const goals = goalsQuery.data ?? [];

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-4 sm:py-5 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-xl font-semibold tracking-tight flex items-center gap-2">
            <Target className="h-5 w-5 text-brand" />
            Goals
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Strategic objectives linked to the tasks that move them.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity self-start sm:self-auto"
        >
          New goal
        </button>
      </header>

      {/* Tab strip — small pills, allowed to overflow horizontally on narrow
          phones rather than wrap to a second row. Audit exception. */}
      <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-1 overflow-x-auto">
        {(['active', 'achieved', 'dropped', 'all'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setStatusTab(t)}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors capitalize',
              statusTab === t
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-4 sm:p-6 md:p-8">
        {goalsQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : goals.length === 0 ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
            {goals.map((g) => (
              <GoalCard key={g.id} goal={g} />
            ))}
          </div>
        )}
      </div>

      {createOpen && <CreateGoalDialog onClose={() => setCreateOpen(false)} />}
    </div>
  );
}
