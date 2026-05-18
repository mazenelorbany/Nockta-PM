import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

import { api } from '../../lib/api';

import type { GoalDetail } from './types';
import { apiErrorMessage } from './util';

export function CreateGoalDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetDate, setTargetDate] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post<GoalDetail>('/goals', {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(targetDate ? { targetDate: new Date(targetDate).toISOString() } : {}),
      }),
    onSuccess: (goal) => {
      toast.success('Goal created');
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      onClose();
      navigate(`/goals/${goal.id}`);
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not create goal')),
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">New goal</h2>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">Name</label>
            <input
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Reach $1M ARR by Q4"
              maxLength={200}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">
              Description
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={5000}
              placeholder="The why behind it"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
            />
          </div>
          <div>
            <label className="nockta-eyebrow text-muted-foreground mb-1 block">
              Target date
            </label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
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
            disabled={!name.trim() || create.isPending}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create goal'}
          </button>
        </div>
      </form>
    </div>
  );
}
