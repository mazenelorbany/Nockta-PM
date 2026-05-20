import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';

import { api } from '../../lib/api';

import type { GoalEvalResponse, RetroResponse } from './types';

// =============================================================================
// Pass I (Sprints 8 → 9). Run retro button + modal.
//
// The button only ever shows on completed sprints. Clicking opens a modal
// with the three classic retro fields plus an action-item editor. The
// modal also captures a goal-evaluation (boolean + optional note) since the
// retro is the moment when teams naturally reflect on whether the sprint
// goal was hit — the two records live in separate tables but are saved in
// quick succession from the same form.
// =============================================================================

export function RunRetroButton({ sprintId }: { sprintId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-brand/5 px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/10 transition"
        title="Open the retrospective modal for this sprint"
      >
        <Sparkles className="h-3 w-3" />
        Run retro
      </button>
      {open && <RetroModal sprintId={sprintId} onClose={() => setOpen(false)} />}
    </>
  );
}

export function RetroModal({
  sprintId,
  onClose,
}: {
  sprintId: string;
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const retroQuery = useQuery({
    queryKey: ['sprint-retro', sprintId],
    queryFn: () => api.get<RetroResponse | null>(`/sprints/${sprintId}/retro`),
  });
  const goalQuery = useQuery({
    queryKey: ['sprint-goal-eval', sprintId],
    queryFn: () => api.get<GoalEvalResponse | null>(`/sprints/${sprintId}/goal-evaluation`),
  });

  const [wentWell, setWentWell] = useState('');
  const [couldImprove, setCouldImprove] = useState('');
  const [actionItems, setActionItems] = useState<RetroResponse['actionItems']>([]);
  const [goalAchieved, setGoalAchieved] = useState<boolean | null>(null);
  const [goalNote, setGoalNote] = useState('');

  useEffect(() => {
    if (retroQuery.data) {
      setWentWell(retroQuery.data.whatWentWell ?? '');
      setCouldImprove(retroQuery.data.whatCouldImprove ?? '');
      setActionItems(retroQuery.data.actionItems ?? []);
    }
  }, [retroQuery.data]);
  useEffect(() => {
    if (goalQuery.data) {
      setGoalAchieved(goalQuery.data.goalAchieved);
      setGoalNote(goalQuery.data.note ?? '');
    }
  }, [goalQuery.data]);

  const saveRetro = useMutation({
    mutationFn: () => api.post(`/sprints/${sprintId}/retro`, {
      whatWentWell: wentWell || null,
      whatCouldImprove: couldImprove || null,
      actionItems: actionItems.map((a) => ({
        id: a.id || crypto.randomUUID(),
        description: a.description,
        ownerUserId: a.ownerUserId,
        status: a.status,
        dueDate: a.dueDate,
      })),
    }),
    onSuccess: async () => {
      // Goal eval is a separate row; save it alongside if the user picked
      // a value. Skipping when null means "don't change my goal eval" so a
      // future re-open doesn't clobber a prior eval.
      if (goalAchieved !== null) {
        await api.post(`/sprints/${sprintId}/goal-evaluation`, {
          goalAchieved,
          note: goalNote || null,
        });
      }
      toast.success('Retro saved');
      void queryClient.invalidateQueries({ queryKey: ['sprint-retro', sprintId] });
      void queryClient.invalidateQueries({ queryKey: ['sprint-goal-eval', sprintId] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save retro'),
  });

  function addActionItem(): void {
    setActionItems((prev) => [
      ...prev,
      { id: crypto.randomUUID(), description: '', ownerUserId: null, status: 'open', dueDate: null },
    ]);
  }

  function updateItem(idx: number, patch: Partial<RetroResponse['actionItems'][number]>): void {
    setActionItems((prev) => prev.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  }

  function removeItem(idx: number): void {
    setActionItems((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <div className="fixed inset-0 z-50 bg-background/90 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-card rounded-lg border border-border shadow-xl max-h-[90vh] overflow-auto">
        <header className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-semibold">Sprint retrospective</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">What went well</label>
            <textarea
              value={wentWell}
              onChange={(e) => setWentWell(e.target.value)}
              rows={3}
              maxLength={5000}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="Wins, surprises, things to keep doing…"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">What could be better</label>
            <textarea
              value={couldImprove}
              onChange={(e) => setCouldImprove(e.target.value)}
              rows={3}
              maxLength={5000}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="Friction points, missed signals, what slowed us down…"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Action items</label>
            <div className="space-y-2">
              {actionItems.map((item, idx) => (
                <div key={item.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={item.status === 'done'}
                    onChange={(e) => updateItem(idx, { status: e.target.checked ? 'done' : 'open' })}
                    className="rounded border-input"
                  />
                  <input
                    type="text"
                    value={item.description}
                    onChange={(e) => updateItem(idx, { description: e.target.value })}
                    maxLength={500}
                    className={cn(
                      'flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm',
                      item.status === 'done' && 'line-through text-muted-foreground',
                    )}
                    placeholder="Time-box planning to 60 minutes…"
                  />
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    aria-label="Remove action item"
                    className="rounded-md p-1 text-muted-foreground hover:bg-accent"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addActionItem}
                className="rounded-md border border-dashed border-border w-full px-3 py-2 text-xs hover:bg-accent"
              >
                <Plus className="h-3 w-3 inline-block mr-1" /> Add action item
              </button>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background/30 p-3 space-y-2">
            <div className="text-xs font-medium">Did we hit the sprint goal?</div>
            <div className="flex items-center gap-2">
              {([
                { v: true, label: 'Yes' },
                { v: false, label: 'No' },
              ] as const).map((opt) => (
                <button
                  key={String(opt.v)}
                  type="button"
                  onClick={() => setGoalAchieved(opt.v)}
                  className={cn(
                    'rounded-md px-3 py-1 text-xs border',
                    goalAchieved === opt.v
                      ? 'bg-brand/10 border-brand/40 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {opt.label}
                </button>
              ))}
              {goalAchieved !== null && (
                <button
                  type="button"
                  onClick={() => { setGoalAchieved(null); setGoalNote(''); }}
                  className="text-xs text-muted-foreground hover:text-foreground ml-1"
                >
                  Clear
                </button>
              )}
            </div>
            {goalAchieved !== null && (
              <input
                type="text"
                value={goalNote}
                onChange={(e) => setGoalNote(e.target.value)}
                maxLength={2000}
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                placeholder="Optional note (what tipped the balance?)"
              />
            )}
          </div>
        </div>
        <footer className="px-6 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => saveRetro.mutate()}
            disabled={saveRetro.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saveRetro.isPending ? 'Saving…' : 'Save retro'}
          </button>
        </footer>
      </div>
    </div>
  );
}
