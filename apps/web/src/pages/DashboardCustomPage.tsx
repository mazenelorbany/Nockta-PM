import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Settings, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { cn } from '@nockta/ui';
import {
  AvatarCircle,
  BlockedBadge,
  DueDateChip,
  PriorityDot,
  StatusPill,
  type Priority,
  type TaskType,
} from '../components/task-bits';
import { api } from '../lib/api';

// =============================================================================
// /dashboards/:id — custom dashboard page that renders a user-defined set of
// widgets. The widget shape is owned by the frontend so adding a new widget
// type doesn't require a schema change.
// =============================================================================

type WidgetKind = 'tasks-list' | 'workload-bars' | 'stat-tiles' | 'sprint-burndown';

interface BaseWidget {
  id: string;
  kind: WidgetKind;
  title?: string;
  /** Per-widget filter overrides on top of the dashboard's baseFilters. */
  filters?: TaskFilter;
}

interface TaskFilter {
  assigneeUserId?: string;
  projectId?: string;
  sprintId?: string;
  status?: string;
  priority?: Priority;
  blocked?: boolean;
  hideDone?: boolean;
  teamId?: string;
}

interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  scope: 'private' | 'workspace' | 'shared';
  ownerUserId: string;
  widgets: BaseWidget[];
  baseFilters: TaskFilter;
  owner: { id: string; name: string; avatarUrl: string | null };
  access?: { id: string; user?: { id: string; name: string }; team?: { id: string; name: string } }[];
}

interface DashboardTask {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  dueDate: string | null;
  assignee?: { id: string; name: string; avatarUrl?: string | null };
  project?: { id: string; key: string; name: string };
}

export function DashboardCustomPage(): JSX.Element {
  const { dashboardId = '' } = useParams<{ dashboardId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const dashboardQuery = useQuery({
    queryKey: ['dashboard', dashboardId],
    queryFn: () => api.get<Dashboard>(`/dashboards/${dashboardId}`),
    enabled: Boolean(dashboardId),
  });
  const dashboard = dashboardQuery.data;

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<Dashboard>) =>
      api.patch<Dashboard>(`/dashboards/${dashboardId}`, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard', dashboardId] });
      void queryClient.invalidateQueries({ queryKey: ['dashboards'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Save failed')),
  });
  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/dashboards/${dashboardId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      toast.success('Dashboard deleted');
      navigate('/');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Delete failed')),
  });

  const [settingsOpen, setSettingsOpen] = useState(false);

  function addWidget(kind: WidgetKind): void {
    if (!dashboard) return;
    const next: BaseWidget = {
      id: crypto.randomUUID(),
      kind,
      filters: {},
    };
    updateMutation.mutate({ widgets: [...dashboard.widgets, next] });
  }
  function removeWidget(widgetId: string): void {
    if (!dashboard) return;
    updateMutation.mutate({ widgets: dashboard.widgets.filter((w) => w.id !== widgetId) });
  }
  function updateWidget(widgetId: string, patch: Partial<BaseWidget>): void {
    if (!dashboard) return;
    updateMutation.mutate({
      widgets: dashboard.widgets.map((w) => (w.id === widgetId ? { ...w, ...patch } : w)),
    });
  }

  if (dashboardQuery.isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!dashboard) {
    return (
      <div className="p-12 max-w-md mx-auto text-center space-y-3">
        <p className="text-sm text-muted-foreground">Dashboard not found or you don't have access.</p>
        <Link to="/" className="text-xs text-primary hover:underline">← Back to home</Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-8 py-5 border-b border-border flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-1">
            <ArrowLeft className="h-3 w-3" /> Home
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">{dashboard.name}</h1>
          {dashboard.description && (
            <p className="mt-1 text-sm text-muted-foreground max-w-2xl">{dashboard.description}</p>
          )}
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <AvatarCircle user={dashboard.owner} size={16} />
            <span>{dashboard.owner.name}</span>
            <span className="rounded bg-secondary/60 px-1.5 py-0.5 text-[10px] uppercase">{dashboard.scope}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <AddWidgetButton onAdd={addWidget} />
          <button
            type="button"
            onClick={() => setSettingsOpen((s) => !s)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition"
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </button>
        </div>
      </header>

      {settingsOpen && (
        <DashboardSettings
          dashboard={dashboard}
          onSave={(p) => updateMutation.mutate(p)}
          onDelete={() => {
            if (window.confirm(`Delete "${dashboard.name}"?`)) deleteMutation.mutate();
          }}
        />
      )}

      <div className="flex-1 overflow-y-auto p-6">
        {dashboard.widgets.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/30 p-12 text-center">
            <p className="text-sm font-medium">Empty dashboard.</p>
            <p className="mt-1 text-xs text-muted-foreground">Add a widget above to start tracking.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {dashboard.widgets.map((w) => (
              <WidgetCard
                key={w.id}
                widget={w}
                baseFilters={dashboard.baseFilters}
                onRemove={() => removeWidget(w.id)}
                onUpdate={(patch) => updateWidget(w.id, patch)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// DashboardSettings — name / description / scope + sharing rows
// =============================================================================

function DashboardSettings({
  dashboard,
  onSave,
  onDelete,
}: {
  dashboard: Dashboard;
  onSave: (patch: Partial<Dashboard>) => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className="px-8 py-4 border-b border-border bg-card/30 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block text-xs">
          <span className="text-muted-foreground">Name</span>
          <input
            type="text"
            defaultValue={dashboard.name}
            onBlur={(e) => {
              if (e.target.value.trim() && e.target.value !== dashboard.name) {
                onSave({ name: e.target.value.trim() });
              }
            }}
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-xs">
          <span className="text-muted-foreground">Description</span>
          <input
            type="text"
            defaultValue={dashboard.description ?? ''}
            onBlur={(e) => {
              if (e.target.value !== (dashboard.description ?? '')) {
                onSave({ description: e.target.value || null });
              }
            }}
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      <label className="block text-xs">
        <span className="text-muted-foreground">Visibility</span>
        <select
          value={dashboard.scope}
          onChange={(e) => onSave({ scope: e.target.value as Dashboard['scope'] })}
          className="mt-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          <option value="private">Private — only me</option>
          <option value="workspace">Workspace — everyone in Nockta can see</option>
          <option value="shared">Shared — specific people / teams</option>
        </select>
      </label>
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
          Delete dashboard
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// AddWidgetButton — dropdown with available widget types
// =============================================================================

function AddWidgetButton({ onAdd }: { onAdd: (kind: WidgetKind) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const widgets: { kind: WidgetKind; label: string; hint: string }[] = [
    { kind: 'tasks-list', label: 'Tasks list', hint: 'Filtered list of tasks (by assignee, project, status…)' },
    { kind: 'workload-bars', label: 'Workload', hint: 'Per-person open-task bars' },
    { kind: 'stat-tiles', label: 'Stat tiles', hint: 'Open / overdue / done counts' },
    { kind: 'sprint-burndown', label: 'Sprint burndown', hint: 'Remaining-effort curve for the active sprint' },
  ];
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 transition"
      >
        <Plus className="h-3.5 w-3.5" />
        Add widget
      </button>
      {open && (
        <>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="fixed inset-0 z-30 bg-transparent cursor-default" />
          <div className="absolute right-0 top-full mt-1 w-72 rounded-lg border border-border bg-popover shadow-xl z-40 p-1">
            {widgets.map((w) => (
              <button
                key={w.kind}
                type="button"
                onClick={() => { onAdd(w.kind); setOpen(false); }}
                className="block w-full text-left rounded-md px-3 py-2 text-sm hover:bg-muted/60"
              >
                <div className="font-medium">{w.label}</div>
                <div className="text-[11px] text-muted-foreground">{w.hint}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// WidgetCard — renders one widget based on its kind
// =============================================================================

function WidgetCard({
  widget,
  baseFilters,
  onRemove,
  onUpdate,
}: {
  widget: BaseWidget;
  baseFilters: TaskFilter;
  onRemove: () => void;
  onUpdate: (patch: Partial<BaseWidget>) => void;
}): JSX.Element {
  const merged: TaskFilter = { ...baseFilters, ...widget.filters };
  return (
    <section className="rounded-xl border border-border bg-card/40 overflow-hidden">
      <header className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border">
        <h2 className="text-sm font-semibold tracking-tight">
          {widget.title ?? defaultWidgetTitle(widget.kind)}
        </h2>
        <div className="flex items-center gap-1">
          <WidgetFilterMenu widget={widget} onUpdate={onUpdate} />
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove widget"
            className="rounded-md p-1 text-muted-foreground hover:text-destructive transition"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      <div className="p-4">
        {widget.kind === 'tasks-list' && <TasksListWidget filters={merged} />}
        {widget.kind === 'workload-bars' && <WorkloadBarsWidget filters={merged} />}
        {widget.kind === 'stat-tiles' && <StatTilesWidget filters={merged} />}
        {widget.kind === 'sprint-burndown' && <SprintBurndownWidget filters={merged} />}
      </div>
    </section>
  );
}

function defaultWidgetTitle(kind: WidgetKind): string {
  switch (kind) {
    case 'tasks-list': return 'Tasks';
    case 'workload-bars': return 'Workload';
    case 'stat-tiles': return 'Stats';
    case 'sprint-burndown': return 'Sprint burndown';
  }
}

// =============================================================================
// Tasks list widget
// =============================================================================

interface SearchResp {
  items: DashboardTask[];
  nextCursor: string | null;
}

function TasksListWidget({ filters }: { filters: TaskFilter }): JSX.Element {
  const qs = new URLSearchParams();
  if (filters.assigneeUserId) qs.set('assigneeUserId', filters.assigneeUserId);
  if (filters.projectId) qs.set('projectId', filters.projectId);
  if (filters.sprintId) qs.set('sprintId', filters.sprintId);
  if (filters.status) qs.set('status', filters.status);
  if (filters.priority) qs.set('priority', filters.priority);
  if (filters.blocked) qs.set('blocked', 'true');
  qs.set('limit', '20');

  const query = useQuery({
    queryKey: ['dashboard-tasks', qs.toString()],
    queryFn: () => api.get<SearchResp>(`/search/tasks?${qs.toString()}`),
  });
  const items = (query.data?.items ?? []).filter((t) =>
    filters.hideDone ? t.status.toLowerCase() !== 'done' : true,
  );

  if (query.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">No tasks match this filter.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {items.map((t) => (
        <li key={t.id} className="flex items-center gap-2 py-2 text-xs">
          <span className="font-mono text-[10px] text-muted-foreground w-20 truncate">{t.key}</span>
          <PriorityDot priority={t.priority} />
          <BlockedBadge blocked={t.isBlocked} />
          <span className="flex-1 truncate">{t.title}</span>
          <StatusPill status={t.status} />
          {t.dueDate && <DueDateChip dueDate={t.dueDate} done={t.status === 'Done'} />}
          {t.assignee && <AvatarCircle user={t.assignee} size={16} />}
        </li>
      ))}
    </ul>
  );
}

// =============================================================================
// Workload widget — open task count per person
// =============================================================================

interface OrgAnalytics {
  workloadTop: { userId: string; openTasks: number; userName?: string }[];
}

function WorkloadBarsWidget({ filters: _filters }: { filters: TaskFilter }): JSX.Element {
  const query = useQuery({
    queryKey: ['analytics', 'org'],
    queryFn: () => api.get<OrgAnalytics>('/analytics/org'),
  });
  const usersQuery = useQuery({
    queryKey: ['users', 'list'],
    queryFn: () => api.get<{ items: { id: string; name: string }[] }>('/users?limit=200'),
  });
  const rows = (query.data?.workloadTop ?? []).slice(0, 10);
  const max = Math.max(1, ...rows.map((r) => r.openTasks));
  const nameMap = new Map((usersQuery.data?.items ?? []).map((u) => [u.id, u.name]));
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No workload data yet.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.userId} className="flex items-center gap-2 text-xs">
          <span className="w-32 truncate">{nameMap.get(r.userId) ?? 'Unknown'}</span>
          <div className="flex-1 h-2 rounded bg-secondary/40 overflow-hidden">
            <div
              className="h-full bg-primary"
              style={{ width: `${(r.openTasks / max) * 100}%` }}
            />
          </div>
          <span className="w-8 text-right tabular-nums text-muted-foreground">{r.openTasks}</span>
        </li>
      ))}
    </ul>
  );
}

// =============================================================================
// Stat tiles widget
// =============================================================================

function StatTilesWidget({ filters }: { filters: TaskFilter }): JSX.Element {
  const qs = new URLSearchParams();
  if (filters.assigneeUserId) qs.set('assigneeUserId', filters.assigneeUserId);
  if (filters.projectId) qs.set('projectId', filters.projectId);
  qs.set('limit', '500');

  const query = useQuery({
    queryKey: ['dashboard-stats', qs.toString()],
    queryFn: () => api.get<SearchResp>(`/search/tasks?${qs.toString()}`),
  });
  const items = query.data?.items ?? [];
  const open = items.filter((t) => t.status.toLowerCase() !== 'done').length;
  const overdue = items.filter((t) => t.dueDate && new Date(t.dueDate) < new Date() && t.status.toLowerCase() !== 'done').length;
  const blocked = items.filter((t) => t.isBlocked).length;
  const done = items.filter((t) => t.status.toLowerCase() === 'done').length;
  return (
    <div className="grid grid-cols-4 gap-3">
      <Tile label="Open" value={open} />
      <Tile label="Overdue" value={overdue} {...(overdue > 0 ? { tone: 'warn' as const } : {})} />
      <Tile label="Blocked" value={blocked} {...(blocked > 0 ? { tone: 'warn' as const } : {})} />
      <Tile label="Done" value={done} />
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'warn' }): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-background/40 p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-xl font-semibold tabular-nums', tone === 'warn' && value > 0 && 'text-priority-high')}>
        {value}
      </p>
    </div>
  );
}

// =============================================================================
// Sprint burndown widget
// =============================================================================

function SprintBurndownWidget({ filters }: { filters: TaskFilter }): JSX.Element {
  if (!filters.projectId) {
    return <p className="text-xs text-muted-foreground">Pick a project in this widget's filter to show burndown.</p>;
  }
  const sprintsQuery = useQuery({
    queryKey: ['sprints', filters.projectId],
    queryFn: () => api.get<{ id: string; name: string; state: string }[]>(`/projects/${filters.projectId}/sprints`),
  });
  const active = (sprintsQuery.data ?? []).find((s) => s.state === 'active');
  const sprintId = filters.sprintId ?? active?.id;
  const burndownQuery = useQuery({
    queryKey: ['burndown', sprintId],
    queryFn: () => api.get<{ points: { date: string; remaining: number }[]; totalTasks: number }>(
      `/analytics/sprints/${sprintId}/burndown`,
    ),
    enabled: Boolean(sprintId),
  });
  if (!sprintId) return <p className="text-xs text-muted-foreground">No active sprint.</p>;
  if (burndownQuery.isLoading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  const points = burndownQuery.data?.points ?? [];
  if (points.length === 0) return <p className="text-xs text-muted-foreground">No data yet.</p>;
  const max = Math.max(1, ...points.map((p) => p.remaining));
  return (
    <div className="grid grid-cols-[1fr_auto] gap-1 items-end h-32">
      <div className="flex items-end gap-1 h-full">
        {points.map((p) => (
          <div
            key={p.date}
            className="flex-1 bg-primary/60 rounded-t-sm"
            style={{ height: `${(p.remaining / max) * 100}%` }}
            title={`${p.date} — ${p.remaining} remaining`}
          />
        ))}
      </div>
      <div className="text-[10px] text-muted-foreground tabular-nums pl-2">
        <p>Max: {max}</p>
        <p>Now: {points[points.length - 1]?.remaining ?? 0}</p>
      </div>
    </div>
  );
}

// =============================================================================
// Widget filter menu — lets users override the dashboard's baseFilters per
// widget (e.g. workload across all projects, but task list only for Project X)
// =============================================================================

function WidgetFilterMenu({
  widget,
  onUpdate,
}: {
  widget: BaseWidget;
  onUpdate: (patch: Partial<BaseWidget>) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ id: string; key: string; name: string }[]>('/projects'),
    enabled: open,
  });
  const usersQuery = useQuery({
    queryKey: ['users', 'list'],
    queryFn: () => api.get<{ items: { id: string; name: string }[] }>('/users?limit=200'),
    enabled: open,
  });
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md p-1 text-muted-foreground hover:text-foreground transition"
        aria-label="Filter widget"
      >
        <Users className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="fixed inset-0 z-30 bg-transparent cursor-default" />
          <div className="absolute right-0 top-full mt-1 w-64 rounded-lg border border-border bg-popover shadow-xl z-40 p-3 space-y-2">
            <label className="block text-xs">
              <span className="text-muted-foreground">Title</span>
              <input
                type="text"
                defaultValue={widget.title ?? ''}
                onBlur={(e) => {
                  const v = e.target.value;
                  onUpdate(v ? { title: v } : ({} as Partial<typeof widget>));
                }}
                placeholder={defaultWidgetTitle(widget.kind)}
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
              />
            </label>
            <label className="block text-xs">
              <span className="text-muted-foreground">Assignee</span>
              <select
                value={widget.filters?.assigneeUserId ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  const { assigneeUserId: _drop, ...rest } = widget.filters ?? {};
                  onUpdate({ filters: v ? { ...rest, assigneeUserId: v } : rest });
                }}
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                <option value="">Anyone</option>
                {(usersQuery.data?.items ?? []).map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="text-muted-foreground">Project</span>
              <select
                value={widget.filters?.projectId ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  const { projectId: _drop, ...rest } = widget.filters ?? {};
                  onUpdate({ filters: v ? { ...rest, projectId: v } : rest });
                }}
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                <option value="">All projects</option>
                {(projectsQuery.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.key} — {p.name}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={Boolean(widget.filters?.hideDone)}
                onChange={(e) => onUpdate({ filters: { ...widget.filters, hideDone: e.target.checked } })}
              />
              Hide done
            </label>
          </div>
        </>
      )}
    </div>
  );
}

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.problem.detail) return err.problem.detail;
    if (err.problem.title) return err.problem.title;
  }
  return fallback;
}
