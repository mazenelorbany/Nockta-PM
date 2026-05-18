import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../../lib/api';
import { Fieldset, Toggle } from '../primitives';

import { ISO_DAYS, type IsoDay, type SnoozeRule } from './types';

// =============================================================================
// Do Not Disturb — recurring weekly snooze windows. CRUD against
// /notifications/snooze-rules. UI is a weekly grid + per-rule editor.
// =============================================================================

export function DoNotDisturbSection(): JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['notifications', 'snooze-rules'],
    queryFn: () => api.get<SnoozeRule[]>('/notifications/snooze-rules'),
  });

  const createMutation = useMutation({
    mutationFn: (body: Omit<SnoozeRule, 'id'>) => api.post('/notifications/snooze-rules', body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['notifications', 'snooze-rules'] }),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, ...rest }: SnoozeRule) =>
      api.patch(`/notifications/snooze-rules/${id}`, rest),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['notifications', 'snooze-rules'] }),
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/notifications/snooze-rules/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['notifications', 'snooze-rules'] }),
  });

  const rules = query.data ?? [];

  return (
    <Fieldset
      legend="Do Not Disturb"
      hint="Recurring quiet hours. During a window, in-app + Chat notifications are dropped (the bell still counts what you missed)."
    >
      <div className="space-y-3">
        {rules.length === 0 && (
          <div className="text-xs text-muted-foreground rounded-md border border-dashed border-border px-4 py-3">
            No quiet hours set. Add one below — e.g. weekday evenings or the whole weekend.
          </div>
        )}
        {rules.map((rule) => (
          <SnoozeRuleCard
            key={rule.id}
            rule={rule}
            onChange={(next) => updateMutation.mutate({ ...rule, ...next })}
            onRemove={() => removeMutation.mutate(rule.id)}
          />
        ))}
        <button
          type="button"
          onClick={() =>
            createMutation.mutate({
              daysOfWeek: ['mon', 'tue', 'wed', 'thu', 'fri'],
              startHour: 19,
              endHour: 9,
              enabled: true,
            })
          }
          className="rounded-md border border-dashed border-border bg-background/40 px-3 py-2 text-xs hover:bg-accent w-full"
        >
          + Add quiet hours
        </button>
      </div>
    </Fieldset>
  );
}

function SnoozeRuleCard({
  rule,
  onChange,
  onRemove,
}: {
  rule: SnoozeRule;
  onChange: (next: Partial<SnoozeRule>) => void;
  onRemove: () => void;
}): JSX.Element {
  function toggleDay(day: IsoDay): void {
    const next = rule.daysOfWeek.includes(day)
      ? rule.daysOfWeek.filter((d) => d !== day)
      : [...rule.daysOfWeek, day];
    if (next.length === 0) return; // keep at least one day
    onChange({ daysOfWeek: next });
  }

  return (
    <div className="rounded-lg border border-border bg-background/40 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex-1 grid grid-cols-7 gap-1">
          {ISO_DAYS.map((d) => {
            const active = rule.daysOfWeek.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => toggleDay(d)}
                className={`tap rounded-md px-1 py-1.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                  active
                    ? 'bg-brand text-brand-foreground'
                    : 'bg-muted/30 text-muted-foreground hover:bg-muted/50'
                }`}
              >
                {d}
              </button>
            );
          })}
        </div>
        <Toggle
          checked={rule.enabled}
          onChange={(v) => onChange({ enabled: v })}
          ariaLabel="Toggle rule"
        />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">From</span>
        <HourSelect value={rule.startHour} onChange={(h) => onChange({ startHour: h })} />
        <span className="text-muted-foreground">to</span>
        <HourSelect value={rule.endHour} onChange={(h) => onChange({ endHour: h })} />
        <span className="text-muted-foreground tabular-nums">
          ({rule.endHour < rule.startHour ? 'overnight, ' : ''}UTC)
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRemove}
          className="tap rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-status-blocked hover:border-status-blocked/40"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function HourSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}): JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
    >
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>
          {h.toString().padStart(2, '0')}:00
        </option>
      ))}
    </select>
  );
}
