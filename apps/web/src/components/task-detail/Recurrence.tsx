import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '@nockta/ui';

import { api } from '../../lib/api';

import { WEEKDAY_LABELS } from './constants';
import type { Recurrence } from './types';
import { humanizeRecurrence } from './utils';

export function RecurrenceSection({ taskId }: { taskId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const recurrenceQuery = useQuery({
    queryKey: ['recurrence', taskId],
    queryFn: () => api.get<Recurrence | null>(`/tasks/${taskId}/recurrence`),
  });
  const r = recurrenceQuery.data;
  const [editing, setEditing] = useState(false);

  const [draft, setDraft] = useState<{
    frequency: 'daily' | 'weekly' | 'monthly';
    interval: number;
    weekdays: number[];
    dayOfMonth: number | null;
  }>({ frequency: 'weekly', interval: 1, weekdays: [], dayOfMonth: null });

  useEffect(() => {
    if (r) {
      setDraft({
        frequency: r.frequency,
        interval: r.interval,
        weekdays: r.weekdays,
        dayOfMonth: r.dayOfMonth,
      });
    }
  }, [r]);

  const upsert = useMutation({
    mutationFn: () => api.put(`/tasks/${taskId}/recurrence`, draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recurrence', taskId] });
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/tasks/${taskId}/recurrence`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recurrence', taskId] });
    },
  });

  return (
    <section className="space-y-2">
      <header className="flex items-center justify-between">
        <h3 className="nockta-eyebrow text-muted-foreground">Repeat</h3>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {r ? 'Edit' : 'Set up'}
          </button>
        )}
      </header>

      {!editing && !r && (
        <p className="text-xs text-muted-foreground">No repeat schedule.</p>
      )}

      {!editing && r && (
        <div className="rounded-lg border border-border bg-card/40 p-3 text-xs">
          <p>
            Repeats {humanizeRecurrence(r)} · next on{' '}
            <strong className="text-foreground">{new Date(r.nextRunAt).toLocaleString()}</strong>
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => remove.mutate()}
              className="text-muted-foreground hover:text-destructive"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="space-y-3 rounded-lg border border-border bg-card/40 p-3 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Frequency</span>
              <select
                value={draft.frequency}
                onChange={(e) => setDraft({ ...draft, frequency: e.target.value as Recurrence['frequency'] })}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Every</span>
              <input
                type="number"
                min={1}
                max={365}
                value={draft.interval}
                onChange={(e) => setDraft({ ...draft, interval: Math.max(1, Number(e.target.value) || 1) })}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              />
            </label>
          </div>
          {draft.frequency === 'weekly' && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Weekdays (optional)</span>
              <div className="mt-1 flex gap-1">
                {WEEKDAY_LABELS.map((label, i) => {
                  const active = draft.weekdays.includes(i);
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          weekdays: active
                            ? draft.weekdays.filter((d) => d !== i)
                            : [...draft.weekdays, i],
                        })
                      }
                      className={cn(
                        'h-7 w-7 rounded-full text-[10px] font-medium transition',
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'border border-border bg-background text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {draft.frequency === 'monthly' && (
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Day of month</span>
              <input
                type="number"
                min={1}
                max={28}
                value={draft.dayOfMonth ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, dayOfMonth: e.target.value ? Number(e.target.value) : null })
                }
                placeholder="Same as task"
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              />
            </label>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={upsert.isPending}
              onClick={() => upsert.mutate()}
              className="rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {upsert.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
