import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';

import { KeyResultsSortableList } from './KeyResultsSortableList';
import type { KeyResult } from './types';
import { apiErrorMessage } from './util';

// =============================================================================
// Key results — measurable sub-targets under a goal. Each KR is a Name +
// current/target numeric pair with a free-text unit. Editing the current
// value updates the goal's rollup percentage in real time.
// =============================================================================

export function KeyResultsCard({
  goalId,
  keyResults,
}: {
  goalId: string;
  keyResults: KeyResult[];
}): JSX.Element {
  const queryClient = useQueryClient();
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['goal', goalId, 'key-results'] });
    void queryClient.invalidateQueries({ queryKey: ['goal', goalId] });
  };

  const create = useMutation({
    mutationFn: (body: { name: string; targetValue: number; unit?: string }) =>
      api.post(`/goals/${goalId}/key-results`, body),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not add key result')),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<KeyResult> }) =>
      api.patch(`/goals/key-results/${id}`, body),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/goals/key-results/${id}`),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete')),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftTarget, setDraftTarget] = useState('100');
  const [draftUnit, setDraftUnit] = useState('');

  function submitAdd(e: React.FormEvent): void {
    e.preventDefault();
    const target = Number(draftTarget);
    if (!draftName.trim() || !Number.isFinite(target) || target <= 0) return;
    create.mutate({
      name: draftName.trim(),
      targetValue: target,
      ...(draftUnit.trim() ? { unit: draftUnit.trim() } : {}),
    });
    setDraftName('');
    setDraftTarget('100');
    setDraftUnit('');
    setAddOpen(false);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">Key results ({keyResults.length})</h2>
        <button
          type="button"
          onClick={() => setAddOpen((o) => !o)}
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <Plus className="h-3 w-3" />
          {addOpen ? 'Cancel' : 'Add KR'}
        </button>
      </div>

      {keyResults.length === 0 && !addOpen ? (
        <p className="text-xs text-muted-foreground">
          No key results yet. KRs make goals measurable —{' '}
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="text-brand hover:underline"
          >
            add one
          </button>
          .
        </p>
      ) : (
        <KeyResultsSortableList
          keyResults={keyResults}
          onUpdate={(id, body) => update.mutate({ id, body })}
          onRemove={(id) => remove.mutate(id)}
        />
      )}

      {addOpen && (
        <form
          onSubmit={submitAdd}
          className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_100px_100px_auto] gap-2 items-start border-t border-border/60 pt-3"
        >
          <input
            required
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Key result name"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <input
            type="number"
            min="0.01"
            step="any"
            value={draftTarget}
            onChange={(e) => setDraftTarget(e.target.value)}
            placeholder="Target"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono"
          />
          <input
            value={draftUnit}
            onChange={(e) => setDraftUnit(e.target.value)}
            placeholder="Unit (optional)"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <button
            type="submit"
            disabled={!draftName.trim() || Number(draftTarget) <= 0}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition"
          >
            Add
          </button>
        </form>
      )}
    </div>
  );
}
