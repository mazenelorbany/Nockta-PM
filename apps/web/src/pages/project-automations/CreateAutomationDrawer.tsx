import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';

import { ActionConfigFields, TriggerConfigFields } from './ConfigFields';
import { Field } from './Field';
import {
  ACTION_OPTIONS,
  STATUSES_BY_PRESET,
  TRIGGER_OPTIONS,
  type Action,
  type Automation,
  type Label,
  type Project,
  type SprintRow,
  type Trigger,
} from './types';
import { apiErrorMessage, defaultConfigForAction } from './utils';

// ============================================================================
// CreateAutomationDrawer
// ============================================================================

export function CreateAutomationDrawer({
  project,
  labels,
  assignees,
  sprints,
  onClose,
  onCreated,
}: {
  project: Project;
  labels: Label[];
  assignees: { id: string; name: string; email: string }[];
  sprints: SprintRow[];
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [trigger, setTrigger] = useState<Trigger>('task_status_changed');
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>({});
  const [action, setAction] = useState<Action>('set_priority');
  const [actionConfig, setActionConfig] = useState<Record<string, unknown>>({ priority: 'High' });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<Automation>(`/projects/${project.id}/automations`, {
        name: name.trim(),
        description: description.trim() || undefined,
        trigger,
        triggerConfig,
        action,
        actionConfig,
        enabled: true,
      }),
    onSuccess: () => onCreated(),
    onError: (err) => toast.error(apiErrorMessage(err, 'Create failed')),
  });

  const statuses = STATUSES_BY_PRESET[project.workflowPreset];
  const canSubmit = name.trim().length > 0 && !createMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="flex-1 bg-black/60"
      />
      <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-border bg-background shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-4 sm:px-6 py-3 sm:py-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">New automation</p>
            <h2 className="mt-0.5 text-base font-semibold">When this, do that</h2>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">
            Close
          </button>
        </header>

        <div className="flex-1 space-y-6 px-4 sm:px-6 py-4 sm:py-6">
          <Field label="Name" required>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Auto-assign high priority to leads"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </Field>

          <Field label="Description" optional>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional — explain what this rule does"
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </Field>

          <section className="space-y-3 rounded-xl border border-border bg-card/40 p-4">
            <header className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
              <span className="rounded-md bg-primary/15 px-2 py-0.5 text-primary">When</span>
              Trigger
            </header>
            <select
              value={trigger}
              onChange={(e) => {
                setTrigger(e.target.value as Trigger);
                setTriggerConfig({});
              }}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
            >
              {TRIGGER_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {TRIGGER_OPTIONS.find((t) => t.value === trigger)?.hint}
            </p>

            <TriggerConfigFields
              trigger={trigger}
              config={triggerConfig}
              onChange={setTriggerConfig}
              statuses={statuses}
              labels={labels}
              assignees={assignees}
            />
          </section>

          <section className="space-y-3 rounded-xl border border-border bg-card/40 p-4">
            <header className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
              <span className="rounded-md bg-accent/30 px-2 py-0.5 text-foreground">Then</span>
              Action
            </header>
            <select
              value={action}
              onChange={(e) => {
                const newAction = e.target.value as Action;
                setAction(newAction);
                setActionConfig(defaultConfigForAction(newAction, statuses));
              }}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
            >
              {ACTION_OPTIONS.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>

            <ActionConfigFields
              action={action}
              config={actionConfig}
              onChange={setActionConfig}
              statuses={statuses}
              labels={labels}
              assignees={assignees}
              sprints={sprints}
            />
          </section>
        </div>

        <footer className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t border-border bg-background px-4 sm:px-6 py-3 sm:py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => createMutation.mutate()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {createMutation.isPending ? 'Creating…' : 'Create automation'}
          </button>
        </footer>
      </div>
    </div>
  );
}
