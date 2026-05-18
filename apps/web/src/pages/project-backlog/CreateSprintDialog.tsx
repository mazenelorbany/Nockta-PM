import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

import { apiErrorMessage } from './helpers';
import type { Sprint } from './types';

// =============================================================================
// CreateSprintDialog — modal for adding a new sprint to this project. Mirrors
// the one that used to live on the standalone Sprints page so the affordance
// is in the same place the sprints are listed.
// =============================================================================

export function CreateSprintDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [goal, setGoal] = useState('');

  const createMutation = useMutation({
    mutationFn: (body: { name: string; startDate?: string; endDate?: string; goal?: string }) =>
      api.post<Sprint>(`/projects/${projectId}/sprints`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sprints(projectId) });
      toast.success('Sprint created');
      onClose();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not create sprint')),
  });

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    if (!name.trim()) return;
    const body: { name: string; startDate?: string; endDate?: string; goal?: string } = { name: name.trim() };
    if (startDate) body.startDate = new Date(startDate).toISOString();
    if (endDate) body.endDate = new Date(endDate).toISOString();
    if (goal.trim()) body.goal = goal.trim();
    createMutation.mutate(body);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">New sprint</h2>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">Name</label>
            <input
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sprint 12"
              maxLength={120}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="nockta-eyebrow text-muted-foreground mb-1 block">Start</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="nockta-eyebrow text-muted-foreground mb-1 block">End</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">
              Goal / theme
              <span className="ml-1 normal-case text-muted-foreground/60">(optional)</span>
            </label>
            <input
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What's the north star for this sprint?"
              maxLength={200}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-[10px] text-muted-foreground mt-1 tabular-nums">
              {goal.length}/200
            </p>
          </div>
        </div>
        <div className="px-6 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || createMutation.isPending}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {createMutation.isPending ? 'Creating…' : 'Create sprint'}
          </button>
        </div>
      </form>
    </div>
  );
}
