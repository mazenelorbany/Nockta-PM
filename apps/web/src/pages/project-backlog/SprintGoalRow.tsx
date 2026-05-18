import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Target } from 'lucide-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';
import { api } from '../../lib/api';
import { apiErrorMessage } from './helpers';
import type { Sprint } from './types';

// =============================================================================
// SprintGoalRow — inline goal/theme editor surfaced under every sprint section.
// Active sprints render the goal prominently (so the team has a north-star
// sentence in front of them all day); planned and completed sprints show a
// subtler version. Click to edit; managers and contributors can persist.
// =============================================================================

export function SprintGoalRow({
  sprintId,
  projectId,
  goal,
  state,
}: {
  sprintId: string;
  projectId: string;
  goal: string | null;
  state: Sprint['state'];
}): JSX.Element {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal ?? '');
  useEffect(() => {
    setDraft(goal ?? '');
  }, [goal]);

  const save = useMutation({
    mutationFn: (next: string | null) =>
      api.patch<Sprint>(`/sprints/${sprintId}`, { goal: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprints', projectId] });
      toast.success(state === 'active' ? 'Goal updated' : 'Goal saved');
      setEditing(false);
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not save goal')),
  });

  // Active sprints get a more visible, slightly accented banner; everything
  // else gets a quiet inline row. The visual hierarchy mirrors which sprint
  // the team should be paying attention to right now.
  const accentForActive = state === 'active';

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = draft.trim();
          save.mutate(trimmed.length > 0 ? trimmed : null);
        }}
        className={cn(
          'flex items-center gap-2 rounded-md border px-2 py-1.5',
          accentForActive
            ? 'border-primary/40 bg-primary/5'
            : 'border-border/60 bg-card/30',
        )}
      >
        <Target className={cn('h-3 w-3 shrink-0', accentForActive ? 'text-primary' : 'text-muted-foreground')} />
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={200}
          placeholder={state === 'active' ? "What's this sprint's north star?" : 'Add a sprint goal…'}
          className="flex-1 bg-transparent text-xs focus:outline-none placeholder:text-muted-foreground"
        />
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {draft.length}/200
        </span>
        <button
          type="submit"
          disabled={save.isPending || draft.trim() === (goal ?? '')}
          className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(goal ?? '');
            setEditing(false);
          }}
          className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </form>
    );
  }

  if (!goal) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          'flex items-center gap-2 rounded-md border border-dashed px-2 py-1.5 w-full text-left transition-colors',
          accentForActive
            ? 'border-primary/30 hover:bg-primary/5'
            : 'border-border/40 hover:bg-card/30',
        )}
      >
        <Target className="h-3 w-3 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">
          {state === 'active' ? 'Set a sprint goal' : 'Add a sprint goal'}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn(
        'flex items-center gap-2 rounded-md border px-2 py-1.5 w-full text-left transition-colors',
        accentForActive
          ? 'border-primary/40 bg-primary/5 hover:bg-primary/10'
          : 'border-border/60 hover:bg-card/40',
      )}
      title="Click to edit"
    >
      <Target className={cn('h-3 w-3 shrink-0', accentForActive ? 'text-primary' : 'text-muted-foreground')} />
      <span
        className={cn(
          'text-xs flex-1 truncate',
          accentForActive ? 'font-medium text-foreground' : 'text-foreground/80',
        )}
      >
        {goal}
      </span>
    </button>
  );
}
