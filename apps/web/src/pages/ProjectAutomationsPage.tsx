import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Power, Trash2, Zap, AlertCircle, CheckCircle2, Clock, History } from 'lucide-react';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useParams } from 'react-router-dom';
import { ProjectTabs } from '../components/ProjectTabs';
import { ApiError } from '@nockta/sdk';
import { cn, NocktaMark } from '@nockta/ui';
import { api } from '../lib/api';

// =============================================================================
// /projects/:projectId/automations — list, create, toggle, and inspect automations.
// =============================================================================

type Trigger =
  | 'task_created'
  | 'task_status_changed'
  | 'task_assigned'
  | 'task_unassigned'
  | 'task_due_soon'
  | 'task_blocked'
  | 'task_labeled'
  | 'comment_added';

type Action =
  | 'set_priority'
  | 'set_assignee'
  | 'add_label'
  | 'remove_label'
  | 'transition_status'
  | 'add_comment'
  | 'add_watcher'
  | 'notify_user'
  | 'set_due_date'
  | 'set_sprint'
  | 'send_webhook';

interface Automation {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: Trigger;
  triggerConfig: Record<string, unknown>;
  action: Action;
  actionConfig: Record<string, unknown>;
  runCount: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string; avatarUrl: string | null };
}

interface AutomationRun {
  id: string;
  status: 'succeeded' | 'skipped' | 'failed';
  message: string | null;
  payload: Record<string, unknown> | null;
  taskId: string | null;
  createdAt: string;
}

interface Project {
  id: string;
  key: string;
  name: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
  sprintsEnabled: boolean;
}

interface Label {
  id: string;
  name: string;
  color: string;
}

interface ProjectAccessRow {
  id: string;
  user?: { id: string; name: string; email: string } | null;
}

interface SprintRow {
  id: string;
  name: string;
  state: 'planned' | 'active' | 'completed';
}

const TRIGGER_OPTIONS: { value: Trigger; label: string; hint: string }[] = [
  { value: 'task_created', label: 'Task created', hint: 'A new task is created in this project' },
  { value: 'task_status_changed', label: 'Status changed', hint: 'A task moves between columns' },
  { value: 'task_assigned', label: 'Task assigned', hint: 'A task gets an assignee' },
  { value: 'task_unassigned', label: 'Task unassigned', hint: 'A task loses its assignee' },
  { value: 'task_blocked', label: 'Task marked blocked', hint: 'Someone flags a task as blocked' },
  { value: 'task_labeled', label: 'Label added', hint: 'A label is attached to a task' },
  { value: 'comment_added', label: 'Comment added', hint: 'Someone comments on a task' },
];

const ACTION_OPTIONS: { value: Action; label: string }[] = [
  { value: 'set_priority', label: 'Set priority' },
  { value: 'set_assignee', label: 'Set assignee' },
  { value: 'add_label', label: 'Add label' },
  { value: 'remove_label', label: 'Remove label' },
  { value: 'transition_status', label: 'Transition status' },
  { value: 'add_comment', label: 'Post a comment' },
  { value: 'add_watcher', label: 'Add a watcher' },
  { value: 'notify_user', label: 'Notify user' },
  { value: 'set_due_date', label: 'Set due date (offset days)' },
  { value: 'set_sprint', label: 'Move to sprint' },
  { value: 'send_webhook', label: 'Send webhook (HTTP POST)' },
];

const STATUSES_BY_PRESET: Record<Project['workflowPreset'], string[]> = {
  engineering: ['Backlog', 'In Progress', 'In Review', 'Done'],
  design: ['Idea', 'Designing', 'Review', 'Approved'],
  generic: ['Todo', 'In Progress', 'Done'],
};

const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;

export function ProjectAutomationsPage(): JSX.Element {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const automationsQuery = useQuery({
    queryKey: ['automations', projectId],
    queryFn: () => api.get<Automation[]>(`/projects/${projectId}/automations`),
    enabled: Boolean(projectId),
  });
  const labelsQuery = useQuery({
    queryKey: ['labels', projectId],
    queryFn: () => api.get<Label[]>(`/projects/${projectId}/labels`),
    enabled: Boolean(projectId),
  });
  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => api.get<ProjectAccessRow[]>(`/projects/${projectId}/access`),
    enabled: Boolean(projectId),
  });
  const sprintsQuery = useQuery({
    queryKey: ['sprints', projectId],
    queryFn: () => api.get<SprintRow[]>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId),
  });

  const project = projectQuery.data;
  const automations = automationsQuery.data ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [openRunsFor, setOpenRunsFor] = useState<string | null>(null);

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<Automation>(`/automations/${id}/toggle`, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations', projectId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Toggle failed')),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/automations/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations', projectId] });
      toast.success('Deleted');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Delete failed')),
  });

  const userMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accessQuery.data ?? []) {
      if (a.user) m.set(a.user.id, a.user.name);
    }
    return m;
  }, [accessQuery.data]);

  return (
    <div>
      <header className="px-4 sm:px-6 md:px-8 py-3 sm:py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          {project?.key && (
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">
              {project.key}
            </span>
          )}
          <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate">
            {project?.name ?? 'Automations'}
          </h1>
          <span className="text-muted-foreground/60 hidden sm:inline">·</span>
          <span className="text-sm text-muted-foreground hidden sm:inline">Automations</span>
        </div>
      </header>

      <ProjectTabs
        projectId={projectId ?? ''}
        actions={
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="tap inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 h-8 text-xs font-semibold hover:opacity-90 transition-opacity"
          >
            <Plus className="h-3.5 w-3.5" />
            New automation
          </button>
        }
      />

      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 py-4 sm:py-6 md:py-8">

      {automationsQuery.isLoading ? (
        <SkeletonList />
      ) : automations.length === 0 ? (
        <EmptyState onCreate={() => setShowCreate(true)} />
      ) : (
        <ul className="space-y-3">
          {automations.map((a) => (
            <AutomationRow
              key={a.id}
              automation={a}
              labels={labelsQuery.data ?? []}
              userMap={userMap}
              onToggle={(enabled) => toggleMutation.mutate({ id: a.id, enabled })}
              onDelete={() => {
                if (confirm(`Delete "${a.name}"?`)) deleteMutation.mutate(a.id);
              }}
              onShowRuns={() => setOpenRunsFor(a.id)}
            />
          ))}
        </ul>
      )}

      {showCreate && project && (
        <CreateAutomationDrawer
          project={project}
          labels={labelsQuery.data ?? []}
          assignees={(accessQuery.data ?? []).filter((a) => a.user).map((a) => a.user!)}
          sprints={sprintsQuery.data ?? []}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void queryClient.invalidateQueries({ queryKey: ['automations', projectId] });
            toast.success('Automation created');
          }}
        />
      )}

      {openRunsFor && (
        <RunsDrawer
          automationId={openRunsFor}
          onClose={() => setOpenRunsFor(null)}
        />
      )}
      </div>
    </div>
  );
}

// ============================================================================
// AutomationRow
// ============================================================================

function AutomationRow({
  automation,
  labels,
  userMap,
  onToggle,
  onDelete,
  onShowRuns,
}: {
  automation: Automation;
  labels: Label[];
  userMap: Map<string, string>;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onShowRuns: () => void;
}): JSX.Element {
  return (
    <li
      className={cn(
        'group relative overflow-hidden rounded-xl border bg-card/60 px-4 sm:px-5 py-4 transition-all hover:border-primary/40',
        !automation.enabled && 'opacity-60'
      )}
    >
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Zap className={cn('h-4 w-4', automation.enabled ? 'text-primary' : 'text-muted-foreground')} />
            <h3 className="truncate text-sm font-semibold">{automation.name}</h3>
            {!automation.enabled && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">Paused</span>
            )}
          </div>
          {automation.description && (
            <p className="mt-1 text-xs text-muted-foreground">{automation.description}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md bg-muted/50 px-2 py-1 font-mono uppercase text-muted-foreground">When</span>
            <code className="rounded-md bg-primary/10 px-2 py-1 font-mono text-primary">
              {humanizeTrigger(automation.trigger, automation.triggerConfig, labels, userMap)}
            </code>
            <span className="rounded-md bg-muted/50 px-2 py-1 font-mono uppercase text-muted-foreground">Then</span>
            <code className="rounded-md bg-accent/20 px-2 py-1 font-mono">
              {humanizeAction(automation.action, automation.actionConfig, labels, userMap)}
            </code>
          </div>
          <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
            <span>Ran <strong className="text-foreground">{automation.runCount}</strong> {automation.runCount === 1 ? 'time' : 'times'}</span>
            {automation.lastRunAt && (
              <span>Last run {timeAgo(automation.lastRunAt)}</span>
            )}
            <span>by {automation.createdBy.name}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onShowRuns}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
            title="Run history"
          >
            <History className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onToggle(!automation.enabled)}
            className={cn(
              'rounded-md p-1.5 transition',
              automation.enabled
                ? 'text-primary hover:bg-primary/10'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
            title={automation.enabled ? 'Pause' : 'Resume'}
          >
            <Power className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </li>
  );
}

// ============================================================================
// CreateAutomationDrawer
// ============================================================================

function CreateAutomationDrawer({
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
        className="flex-1 bg-black/40 backdrop-blur-sm"
      />
      <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-border bg-background shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-4 sm:px-6 py-3 sm:py-4 backdrop-blur">
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

        <footer className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t border-border bg-background/95 px-4 sm:px-6 py-3 sm:py-4 backdrop-blur">
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

// ============================================================================
// Trigger / Action config fields
// ============================================================================

function TriggerConfigFields({
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

function ActionConfigFields({
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

function defaultConfigForAction(action: Action, statuses: string[]): Record<string, unknown> {
  switch (action) {
    case 'set_priority': return { priority: 'High' };
    case 'transition_status': return { status: statuses[0] };
    case 'add_comment': return { body: '' };
    case 'set_due_date': return { offsetDays: 7 };
    case 'set_sprint': return { sprintId: null };
    default: return {};
  }
}

// ============================================================================
// Runs drawer
// ============================================================================

function RunsDrawer({ automationId, onClose }: { automationId: string; onClose: () => void }): JSX.Element {
  const runsQuery = useQuery({
    queryKey: ['automation-runs', automationId],
    queryFn: () => api.get<AutomationRun[]>(`/automations/${automationId}/runs`),
    refetchInterval: 5000,
  });
  return (
    <div className="fixed inset-0 z-50 flex">
      <button type="button" aria-label="Close" onClick={onClose} className="flex-1 bg-black/40 backdrop-blur-sm" />
      <div className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-background shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-6 py-4 backdrop-blur">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Automation</p>
            <h2 className="mt-0.5 text-base font-semibold">Run history</h2>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">Close</button>
        </header>
        <div className="flex-1 px-6 py-4">
          {runsQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {runsQuery.data && runsQuery.data.length === 0 && (
            <p className="text-sm text-muted-foreground">Not yet triggered — when the trigger fires, runs will show up here.</p>
          )}
          <ul className="space-y-2">
            {(runsQuery.data ?? []).map((r) => (
              <li key={r.id} className="rounded-lg border border-border bg-card/40 p-3 text-sm">
                <div className="flex items-center gap-2">
                  {r.status === 'succeeded' && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
                  {r.status === 'skipped' && <Clock className="h-4 w-4 text-muted-foreground" />}
                  {r.status === 'failed' && <AlertCircle className="h-4 w-4 text-destructive" />}
                  <span className="capitalize">{r.status}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{timeAgo(r.createdAt)}</span>
                </div>
                {r.message && <p className="mt-1 text-xs text-muted-foreground">{r.message}</p>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Reusable bits
// ============================================================================

function Field({ label, children, required, optional }: { label: string; children: React.ReactNode; required?: boolean; optional?: boolean }): JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
        {optional && <span className="ml-1 text-muted-foreground">(optional)</span>}
      </span>
      {children}
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </Field>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/30 p-12 text-center">
      <Zap className="mx-auto h-8 w-8 text-muted-foreground" />
      <h3 className="mt-3 text-base font-semibold">No automations yet</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        Set up "when this, do that" rules — auto-assign tasks, post status comments, escalate blockers without lifting a finger.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
      >
        <Plus className="h-4 w-4" />
        Create your first automation
      </button>
    </div>
  );
}

function SkeletonList(): JSX.Element {
  return (
    <ul className="space-y-3">
      {[0, 1, 2].map((i) => (
        <li key={i} className="h-24 animate-pulse rounded-xl border border-border bg-card/40" />
      ))}
    </ul>
  );
}

// ============================================================================
// Humanizers — turn config into prose
// ============================================================================

function humanizeTrigger(
  trigger: Trigger,
  config: Record<string, unknown>,
  labels: Label[],
  userMap: Map<string, string>,
): string {
  switch (trigger) {
    case 'task_created': return 'a task is created';
    case 'task_status_changed': {
      const from = config.fromStatus as string | undefined;
      const to = config.toStatus as string | undefined;
      if (from && to) return `status: ${from} → ${to}`;
      if (to) return `status → ${to}`;
      if (from) return `status leaves ${from}`;
      return 'status changes';
    }
    case 'task_assigned': {
      const u = config.assigneeUserId as string | undefined;
      return u ? `assigned to ${userMap.get(u) ?? '…'}` : 'task assigned';
    }
    case 'task_unassigned': return 'assignee removed';
    case 'task_blocked': return 'task marked blocked';
    case 'task_labeled': {
      const id = config.labelId as string | undefined;
      const l = labels.find((x) => x.id === id);
      return l ? `label "${l.name}" added` : 'a label is added';
    }
    case 'comment_added': return 'a comment is added';
    case 'task_due_soon': return 'due date approaching';
    default: return trigger;
  }
}

function humanizeAction(
  action: Action,
  config: Record<string, unknown>,
  labels: Label[],
  userMap: Map<string, string>,
): string {
  switch (action) {
    case 'set_priority': return `priority → ${config.priority}`;
    case 'set_assignee': {
      const u = config.assigneeUserId as string;
      return `assign to ${userMap.get(u) ?? '…'}`;
    }
    case 'add_label': {
      const l = labels.find((x) => x.id === config.labelId);
      return l ? `add label "${l.name}"` : 'add label';
    }
    case 'remove_label': {
      const l = labels.find((x) => x.id === config.labelId);
      return l ? `remove label "${l.name}"` : 'remove label';
    }
    case 'transition_status': return `move to ${config.status}`;
    case 'add_comment': return 'post a comment';
    case 'add_watcher': return `add watcher ${userMap.get(config.userId as string) ?? '…'}`;
    case 'notify_user': return `notify ${userMap.get(config.userId as string) ?? '…'}`;
    case 'set_due_date': return `set due date +${config.offsetDays}d`;
    case 'set_sprint': return config.sprintId ? 'move to sprint' : 'remove from sprint';
    default: return action;
  }
}

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.problem.detail) return err.problem.detail;
    if (err.problem.title) return err.problem.title;
  }
  return fallback;
}
