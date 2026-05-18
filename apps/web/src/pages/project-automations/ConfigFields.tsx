import { Field, SelectField } from './Field';
import { PRIORITIES, type Action, type Label, type SprintRow, type Trigger } from './types';

// ============================================================================
// Trigger / Action config fields
// ============================================================================

export function TriggerConfigFields({
  trigger,
  config,
  onChange,
  statuses,
  labels,
  assignees,
}: {
  trigger: Trigger;
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
  statuses: string[];
  labels: Label[];
  assignees: { id: string; name: string; email: string }[];
}): JSX.Element | null {
  if (trigger === 'task_status_changed') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label="From status"
          value={(config.fromStatus as string) ?? ''}
          onChange={(v) => onChange({ ...config, fromStatus: v || undefined })}
          options={[{ value: '', label: 'Any' }, ...statuses.map((s) => ({ value: s, label: s }))]}
        />
        <SelectField
          label="To status"
          value={(config.toStatus as string) ?? ''}
          onChange={(v) => onChange({ ...config, toStatus: v || undefined })}
          options={[{ value: '', label: 'Any' }, ...statuses.map((s) => ({ value: s, label: s }))]}
        />
      </div>
    );
  }
  if (trigger === 'task_labeled') {
    return (
      <SelectField
        label="Label (optional)"
        value={(config.labelId as string) ?? ''}
        onChange={(v) => onChange({ ...config, labelId: v || undefined })}
        options={[{ value: '', label: 'Any label' }, ...labels.map((l) => ({ value: l.id, label: l.name }))]}
      />
    );
  }
  if (trigger === 'task_assigned') {
    return (
      <SelectField
        label="Specific user (optional)"
        value={(config.assigneeUserId as string) ?? ''}
        onChange={(v) => onChange({ ...config, assigneeUserId: v || undefined })}
        options={[{ value: '', label: 'Any assignee' }, ...assignees.map((u) => ({ value: u.id, label: u.name }))]}
      />
    );
  }
  return null;
}

export function ActionConfigFields({
  action,
  config,
  onChange,
  statuses,
  labels,
  assignees,
  sprints,
}: {
  action: Action;
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
  statuses: string[];
  labels: Label[];
  assignees: { id: string; name: string; email: string }[];
  sprints: SprintRow[];
}): JSX.Element | null {
  switch (action) {
    case 'set_priority':
      return (
        <SelectField
          label="Priority"
          value={(config.priority as string) ?? 'High'}
          onChange={(v) => onChange({ priority: v })}
          options={PRIORITIES.map((p) => ({ value: p, label: p }))}
        />
      );
    case 'set_assignee':
    case 'add_watcher':
    case 'notify_user':
      return (
        <div className="space-y-2">
          <SelectField
            label="User"
            value={(config.userId ?? config.assigneeUserId) as string ?? ''}
            onChange={(v) => onChange(action === 'set_assignee' ? { assigneeUserId: v } : { ...config, userId: v })}
            options={[{ value: '', label: 'Select…' }, ...assignees.map((u) => ({ value: u.id, label: u.name }))]}
          />
          {action === 'notify_user' && (
            <Field label="Message" optional>
              <input
                value={(config.message as string) ?? ''}
                onChange={(e) => onChange({ ...config, message: e.target.value })}
                placeholder="Heads up — a task just changed"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
              />
            </Field>
          )}
        </div>
      );
    case 'add_label':
    case 'remove_label':
      return (
        <SelectField
          label="Label"
          value={(config.labelId as string) ?? ''}
          onChange={(v) => onChange({ labelId: v })}
          options={[{ value: '', label: 'Select…' }, ...labels.map((l) => ({ value: l.id, label: l.name }))]}
        />
      );
    case 'transition_status':
      return (
        <SelectField
          label="New status"
          value={(config.status as string) ?? statuses[0]}
          onChange={(v) => onChange({ status: v })}
          options={statuses.map((s) => ({ value: s, label: s }))}
        />
      );
    case 'add_comment':
      return (
        <Field label="Comment body">
          <textarea
            value={(config.body as string) ?? ''}
            onChange={(e) => onChange({ body: e.target.value })}
            rows={3}
            placeholder="Auto-comment text"
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </Field>
      );
    case 'set_due_date':
      return (
        <Field label="Days from now">
          <input
            type="number"
            value={Number(config.offsetDays ?? 7)}
            onChange={(e) => onChange({ offsetDays: Number(e.target.value) })}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </Field>
      );
    case 'set_sprint':
      return (
        <SelectField
          label="Sprint"
          value={(config.sprintId as string) ?? ''}
          onChange={(v) => onChange({ sprintId: v || null })}
          options={[
            { value: '', label: '(Unset)' },
            ...sprints.map((s) => ({ value: s.id, label: `${s.name} (${s.state})` })),
          ]}
        />
      );
    default:
      return null;
  }
}
