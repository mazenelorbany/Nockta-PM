import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';

import { api } from '../../lib/api';
import { isFieldVisible } from '../../lib/formula-evaluator';

import { Section } from './Section';
import type { CustomFieldDef, CustomFieldValueRow } from './types';
import { apiErrorMessage } from './utils';

// =============================================================================
// SmartDatePicker — date input with quick-pick shortcuts (today, tomorrow,
// next Friday, in 2 weeks, in 1 month). Used wherever a custom-field "date"
// is edited; the underlying input is still <input type="date"> so browser
// keyboard + calendar still work, the chips just pre-fill it.
//
// The shortcut math runs in the user's local timezone (Date constructor),
// matching how the rest of the app reads + displays dates. ISO output stays
// UTC-normalized at midnight.
// =============================================================================

export function SmartDatePicker({
  value,
  onChange,
  inputClass,
}: {
  value: string | null;
  onChange: (iso: string | null) => void;
  inputClass: string;
}): JSX.Element {
  // The native date input wants 'YYYY-MM-DD'. We accept ISO timestamps as
  // input and slice off the date portion.
  const isoDate = value ? value.slice(0, 10) : '';

  function todayIso(offsetDays: number): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    // Build ISO at local midnight then re-stringify in UTC for parity with
    // the server (which stores all dates UTC).
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString();
  }

  function nextWeekday(target: number /* 0=Sun..6=Sat */): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const delta = (target - d.getDay() + 7) % 7 || 7; // always strictly after today
    d.setDate(d.getDate() + delta);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString();
  }

  const chips: { label: string; iso: () => string }[] = [
    { label: 'Today', iso: () => todayIso(0) },
    { label: 'Tomorrow', iso: () => todayIso(1) },
    { label: 'Fri', iso: () => nextWeekday(5) },
    { label: 'Mon', iso: () => nextWeekday(1) },
    { label: '+1w', iso: () => todayIso(7) },
    { label: '+2w', iso: () => todayIso(14) },
    { label: '+1mo', iso: () => todayIso(30) },
  ];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          type="date"
          defaultValue={isoDate}
          key={isoDate}
          onBlur={(e) =>
            onChange(e.target.value ? new Date(e.target.value).toISOString() : null)
          }
          className={inputClass}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-muted-foreground hover:text-foreground"
            aria-label="Clear date"
            title="Clear"
          >
            ✕
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {chips.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => onChange(c.iso())}
            className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-background/40 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CustomFieldsSection({ taskId, projectId }: { taskId: string; projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const fieldsQuery = useQuery({
    queryKey: ['custom-fields', projectId],
    queryFn: () => api.get<CustomFieldDef[]>(`/projects/${projectId}/custom-fields`),
  });
  const valuesQuery = useQuery({
    queryKey: ['custom-field-values', taskId],
    queryFn: () => api.get<CustomFieldValueRow[]>(`/tasks/${taskId}/custom-fields`),
  });

  const setValue = useMutation({
    mutationFn: ({ fieldId, value }: { fieldId: string; value: unknown }) =>
      api.put(`/tasks/${taskId}/custom-fields/${fieldId}`, { value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['custom-field-values', taskId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not save')),
  });

  const fields = (fieldsQuery.data ?? []).slice().sort((a, b) => a.position - b.position);
  const valuesByField = new Map<string, unknown>();
  for (const v of valuesQuery.data ?? []) valuesByField.set(v.fieldId, v.value);

  // Client-side visibility filter — the server ALSO strips hidden rows
  // from the response (defense in depth so a hidden-field value never
  // leaks), but the editor list also has rows for fields with no value
  // yet, and those won't appear in `valuesByField`. We need to hide
  // those proactively too. The var bag for evaluating visibilityRule is
  // keyed by field NAME, matching the server expression syntax.
  const varBag: Record<string, unknown> = Object.create(null);
  for (const f of fields) {
    const v = valuesByField.get(f.id);
    varBag[f.name] = v ?? null;
  }
  const visibleFields = fields.filter((f) =>
    isFieldVisible(f.visibilityRule ?? null, varBag),
  );

  if (visibleFields.length === 0) return <></>;

  return (
    <Section title="Custom fields">
      <div className="space-y-2">
        {visibleFields.map((f) => (
          <CustomFieldRow
            key={f.id}
            field={f}
            value={valuesByField.get(f.id)}
            onChange={(value) => setValue.mutate({ fieldId: f.id, value })}
          />
        ))}
      </div>
    </Section>
  );
}

/**
 * Render a read-only computed cell for kind='formula' | 'rollup'. The
 * server has already evaluated the expression and supplied the value;
 * we just have to display it with the right prefix glyph and "muted"
 * styling so it's visually distinct from an editable cell.
 */
function ComputedCell({
  field,
  value,
  inputClass,
}: {
  field: CustomFieldDef;
  value: unknown;
  inputClass: string;
}): JSX.Element {
  const prefix = field.kind === 'formula' ? 'fx' : 'Σ';
  const isErr = typeof value === 'string' && value.startsWith('#ERR');
  const display = formatComputedValue(value);
  return (
    <div
      className={cn(
        inputClass,
        'flex items-center gap-2 cursor-default select-text',
        isErr ? 'text-destructive' : 'text-foreground/80',
      )}
      title={
        field.kind === 'formula'
          ? `Formula: ${field.formulaExpression ?? '(none)'}`
          : `Rollup: ${field.rollupConfig?.agg ?? '?'}(${field.rollupConfig?.relation ?? '?'}.${field.rollupConfig?.field ?? '?'})`
      }
    >
      <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-mono uppercase text-muted-foreground">
        {prefix}
      </span>
      <span className="truncate">{display}</span>
    </div>
  );
}

function formatComputedValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    // Trim long decimals so a rollup average doesn't show "1.6666666666"
    if (!Number.isInteger(v)) return v.toFixed(2).replace(/\.0+$/, '');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function CustomFieldRow({
  field,
  value,
  onChange,
}: {
  field: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}): JSX.Element {
  const inputClass = 'rounded-md border border-input bg-background px-2 py-1 text-xs flex-1';
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-32 shrink-0 truncate text-muted-foreground">
        {field.name}
        {field.required && <span className="ml-1 text-destructive">*</span>}
      </span>
      {field.kind === 'text' && (
        <input
          type="text"
          defaultValue={(value as string | null) ?? ''}
          onBlur={(e) => onChange(e.target.value || null)}
          className={inputClass}
        />
      )}
      {field.kind === 'number' && (
        <input
          type="number"
          defaultValue={(value as number | null) ?? ''}
          onBlur={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          className={inputClass}
        />
      )}
      {field.kind === 'url' && (
        <input
          type="url"
          placeholder="https://…"
          defaultValue={(value as string | null) ?? ''}
          onBlur={(e) => onChange(e.target.value || null)}
          className={inputClass}
        />
      )}
      {field.kind === 'date' && (
        <SmartDatePicker
          value={value as string | null}
          onChange={(iso) => onChange(iso)}
          inputClass={inputClass}
        />
      )}
      {field.kind === 'checkbox' && (
        <input
          type="checkbox"
          checked={(value as boolean | null) ?? false}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4"
        />
      )}
      {field.kind === 'select' && (
        <select
          value={(value as string | null) ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          className={inputClass}
        >
          <option value="">—</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}
      {field.kind === 'multiselect' && (
        <div className="flex flex-wrap gap-1">
          {field.options.map((o) => {
            const arr = Array.isArray(value) ? (value as string[]) : [];
            const active = arr.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  const next = active ? arr.filter((v) => v !== o.value) : [...arr, o.value];
                  onChange(next);
                }}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] transition',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
      {(field.kind === 'formula' || field.kind === 'rollup') && (
        <ComputedCell field={field} value={value} inputClass={inputClass} />
      )}
    </label>
  );
}
