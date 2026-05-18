import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Database } from 'lucide-react';
import { api } from '../../lib/api';
import { Section } from './shared';
import { apiErrorMessage } from './utils';
import type { CustomFieldDef, FieldKind, RollupConfig, VisibilityRule } from './types';

// =============================================================================
// CustomFieldsAdmin — manage per-project custom field definitions.
//
// Round 6 / Pass C extends this beyond the original text/number/select scope
// with three new field shapes:
//   - formula  — read-only expression evaluated server-side at fetch time
//   - rollup   — aggregate over subtasks or linked tasks
//   - any kind — can carry a `visibilityRule` that hides it conditionally
//
// The editor uses the API's parse-only `validate-formula` endpoint (debounced
// 500ms) for live syntax checking, and the per-field `:id/validate-formula`
// endpoint for the "Test expression" button which evaluates against a real
// task and returns a sampleResult preview.
// =============================================================================

export function CustomFieldsSection({ projectId }: { projectId: string }): JSX.Element {
  return (
    <Section
      id="custom-fields"
      icon={<Database className="h-4 w-4" />}
      title="Custom fields"
      hint="Per-project user-defined fields shown on every task in this project."
    >
      <CustomFieldsAdmin projectId={projectId} />
    </Section>
  );
}

function CustomFieldsAdmin({ projectId }: { projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const fieldsQuery = useQuery({
    queryKey: ['custom-fields', projectId],
    queryFn: () => api.get<CustomFieldDef[]>(`/projects/${projectId}/custom-fields`),
  });
  const [draft, setDraft] = useState<{
    name: string;
    kind: FieldKind;
    optionsText: string;
    required: boolean;
    formulaExpression: string;
    rollupRelation: 'subtasks' | 'linkedTasks';
    rollupField: string;
    rollupAgg: RollupConfig['agg'];
    visibilityEnabled: boolean;
    visibilityFieldKey: string;
    visibilityOp: 'equals' | 'in' | 'isSet';
    visibilityValue: string;
  }>({
    name: '',
    kind: 'text',
    optionsText: '',
    required: false,
    formulaExpression: '',
    rollupRelation: 'subtasks',
    rollupField: 'estimate',
    rollupAgg: 'sum',
    visibilityEnabled: false,
    visibilityFieldKey: '',
    visibilityOp: 'equals',
    visibilityValue: '',
  });

  // Live formula syntax check — debounced 500ms. The user gets a green
  // "Valid" or a red error inline, and the Add button stays enabled either
  // way (we don't block the server-side recheck on the editor's opinion).
  const [formulaSyntax, setFormulaSyntax] = useState<{ ok: boolean; error?: string } | null>(null);
  useEffect(() => {
    if (draft.kind !== 'formula' || !draft.formulaExpression.trim()) {
      setFormulaSyntax(null);
      return;
    }
    const t = setTimeout(() => {
      void api
        .post<{ ok: boolean; error?: string }>('/custom-fields/validate-formula', {
          expression: draft.formulaExpression,
        })
        .then(setFormulaSyntax)
        .catch(() => setFormulaSyntax({ ok: false, error: 'Server unreachable' }));
    }, 500);
    return () => clearTimeout(t);
  }, [draft.kind, draft.formulaExpression]);

  // Same debounce for the visibility-rule expression-like input. We DON'T
  // call the formula validator for visibility (the schema differs — it's a
  // structured rule, not a free expression), so the check is purely
  // structural: fieldKey must be non-empty.
  const visibilityValid =
    !draft.visibilityEnabled ||
    (draft.visibilityFieldKey.trim() !== '' &&
      (draft.visibilityOp === 'isSet' || draft.visibilityValue.trim() !== ''));

  const create = useMutation({
    mutationFn: () => {
      const needsOptions = draft.kind === 'select' || draft.kind === 'multiselect';
      const options = needsOptions
        ? draft.optionsText
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((label) => ({ value: label, label }))
        : undefined;
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        kind: draft.kind,
        options,
        required: draft.required,
      };
      if (draft.kind === 'formula') {
        body.formulaExpression = draft.formulaExpression.trim();
      }
      if (draft.kind === 'rollup') {
        body.rollupConfig = {
          relation: draft.rollupRelation,
          field: draft.rollupField.trim(),
          agg: draft.rollupAgg,
        } satisfies RollupConfig;
      }
      if (draft.visibilityEnabled && draft.visibilityFieldKey.trim()) {
        let value: unknown = draft.visibilityValue;
        if (draft.visibilityOp === 'in') {
          value = draft.visibilityValue
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        } else if (draft.visibilityOp === 'isSet') {
          value = undefined;
        }
        body.visibilityRule = {
          when: {
            fieldKey: draft.visibilityFieldKey.trim(),
            op: draft.visibilityOp,
            ...(value !== undefined ? { value } : {}),
          },
        } satisfies VisibilityRule;
      }
      return api.post(`/projects/${projectId}/custom-fields`, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['custom-fields', projectId] });
      setDraft({
        name: '',
        kind: 'text',
        optionsText: '',
        required: false,
        formulaExpression: '',
        rollupRelation: 'subtasks',
        rollupField: 'estimate',
        rollupAgg: 'sum',
        visibilityEnabled: false,
        visibilityFieldKey: '',
        visibilityOp: 'equals',
        visibilityValue: '',
      });
      setFormulaSyntax(null);
      toast.success('Field created');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Create failed')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/custom-fields/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['custom-fields', projectId] });
    },
  });

  // Section header is rendered by the outer page; this component just emits
  // its content so it can sit cleanly inside the unified Section frame.
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {(fieldsQuery.data ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground">No custom fields yet.</p>
        )}
        {(fieldsQuery.data ?? []).map((f) => (
          <div key={f.id} className="flex items-center gap-3 rounded-md border border-border bg-card/40 px-3 py-2 text-xs">
            <span className="font-medium">{f.name}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
              {f.kind}
            </span>
            {f.required && <span className="text-destructive">required</span>}
            {(f.kind === 'select' || f.kind === 'multiselect') && (
              <span className="text-muted-foreground">{f.options.length} options</span>
            )}
            <button
              type="button"
              onClick={() => {
                if (confirm(`Delete field "${f.name}"? Existing values will be hidden.`)) remove.mutate(f.id);
              }}
              className="ml-auto text-muted-foreground hover:text-destructive"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-card/40 p-3 space-y-2 mt-3">
        <div className="text-xs nockta-eyebrow text-muted-foreground">Add field</div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_auto] gap-2">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Field name"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <select
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as FieldKind })}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="select">Select</option>
            <option value="multiselect">Multi-select</option>
            <option value="date">Date</option>
            <option value="url">URL</option>
            <option value="checkbox">Checkbox</option>
            <option value="formula">Formula (computed)</option>
            <option value="rollup">Rollup (aggregate)</option>
          </select>
          <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={draft.required}
              onChange={(e) => setDraft({ ...draft, required: e.target.checked })}
              disabled={draft.kind === 'formula' || draft.kind === 'rollup'}
            />
            Required
          </label>
        </div>
        {(draft.kind === 'select' || draft.kind === 'multiselect') && (
          <textarea
            value={draft.optionsText}
            onChange={(e) => setDraft({ ...draft, optionsText: e.target.value })}
            placeholder="One option per line"
            rows={3}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
        )}
        {draft.kind === 'formula' && (
          <div className="space-y-1.5">
            <textarea
              value={draft.formulaExpression}
              onChange={(e) => setDraft({ ...draft, formulaExpression: e.target.value })}
              placeholder={`Expression — references other fields via {fieldName}\n  e.g. {estimate} * 2\n  e.g. if({status} == "Done", 1, 0)\n  e.g. daysBetween({startDate}, {dueDate})`}
              rows={4}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono"
            />
            <div className="flex items-center justify-between text-[11px]">
              {formulaSyntax === null && (
                <span className="text-muted-foreground">
                  References: <code>{'{fieldName}'}</code> · functions: if, sum, min, max, avg, count, len, lower, upper, daysBetween, now
                </span>
              )}
              {formulaSyntax?.ok && (
                <span className="text-emerald-600 dark:text-emerald-400">Valid syntax</span>
              )}
              {formulaSyntax && !formulaSyntax.ok && (
                <span className="text-destructive">{formulaSyntax.error}</span>
              )}
            </div>
          </div>
        )}
        {draft.kind === 'rollup' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Relation</span>
              <select
                value={draft.rollupRelation}
                onChange={(e) =>
                  setDraft({ ...draft, rollupRelation: e.target.value as 'subtasks' | 'linkedTasks' })
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                <option value="subtasks">Subtasks</option>
                <option value="linkedTasks">Linked tasks</option>
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Target field</span>
              <input
                type="text"
                value={draft.rollupField}
                onChange={(e) => setDraft({ ...draft, rollupField: e.target.value })}
                placeholder="estimate or sibling field name"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Aggregator</span>
              <select
                value={draft.rollupAgg}
                onChange={(e) =>
                  setDraft({ ...draft, rollupAgg: e.target.value as RollupConfig['agg'] })
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                <option value="sum">Sum</option>
                <option value="avg">Average</option>
                <option value="min">Min</option>
                <option value="max">Max</option>
                <option value="count">Count</option>
              </select>
            </label>
          </div>
        )}
        <div className="space-y-1.5 border-t border-border/40 pt-2">
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={draft.visibilityEnabled}
              onChange={(e) => setDraft({ ...draft, visibilityEnabled: e.target.checked })}
            />
            Show this field only when…
          </label>
          {draft.visibilityEnabled && (
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_1fr] gap-2 pl-5">
              <input
                type="text"
                value={draft.visibilityFieldKey}
                onChange={(e) => setDraft({ ...draft, visibilityFieldKey: e.target.value })}
                placeholder="Other field name (e.g. priority)"
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
              />
              <select
                value={draft.visibilityOp}
                onChange={(e) =>
                  setDraft({ ...draft, visibilityOp: e.target.value as 'equals' | 'in' | 'isSet' })
                }
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
              >
                <option value="equals">equals</option>
                <option value="in">in (comma-separated)</option>
                <option value="isSet">is set</option>
              </select>
              {draft.visibilityOp !== 'isSet' && (
                <input
                  type="text"
                  value={draft.visibilityValue}
                  onChange={(e) => setDraft({ ...draft, visibilityValue: e.target.value })}
                  placeholder={draft.visibilityOp === 'in' ? 'High, Critical' : 'High'}
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                />
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            disabled={
              !draft.name.trim() ||
              create.isPending ||
              (draft.kind === 'formula' && !draft.formulaExpression.trim()) ||
              (draft.kind === 'rollup' && !draft.rollupField.trim()) ||
              !visibilityValid
            }
            onClick={() => create.mutate()}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending ? 'Adding…' : 'Add field'}
          </button>
        </div>
      </div>
    </div>
  );
}
