import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

import type { Priority, User } from './types';

/**
 * Collects the four bulk-mutation flows (status / generic patch / label
 * attach-detach / delete) used by `BulkActionBar`. Each mutation chunks
 * requests to 8 in parallel, then invalidates the project's task list and
 * surfaces a partial-success toast. Lives next to the JSX that consumes it
 * so the floating bar can move as a single unit.
 */
export function useBulkActions({
  projectId,
  onClearSelection,
}: {
  projectId: string | undefined;
  onClearSelection: () => void;
}): {
  bulkStatusMutation: ReturnType<typeof useMutation<{ succeeded: number; errorCount: number; firstError: string | undefined }, Error, { ids: string[]; status: string }>>;
  bulkPatch: ReturnType<typeof useMutation<{ succeeded: number; errorCount: number; firstError: string | undefined; label: string }, Error, { ids: string[]; body: Record<string, unknown>; label: string }>>;
  bulkLabel: ReturnType<typeof useMutation<{ succeeded: number; errorCount: number; firstError: string | undefined; mode: 'attach' | 'detach' }, Error, { ids: string[]; labelId: string; mode: 'attach' | 'detach' }>>;
  bulkDelete: ReturnType<typeof useMutation<{ succeeded: number; errorCount: number; firstError: string | undefined }, Error, string[]>>;
} {
  const queryClient = useQueryClient();

  const bulkStatusMutation = useMutation({
    mutationFn: async ({ ids, status }: { ids: string[]; status: string }) => {
      // Chunk to 8 parallel requests at a time — keeps the API event bus from
      // getting hammered with 100+ simultaneous status-change events.
      const CHUNK = 8;
      let succeeded = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const results = await Promise.allSettled(
          batch.map((id) => api.patch(`/tasks/${id}/status`, { status })),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') succeeded++;
          else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      }
      return { succeeded, errorCount: errors.length, firstError: errors[0] };
    },
    onSuccess: ({ succeeded, errorCount, firstError }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
      onClearSelection();
      if (errorCount === 0) {
        toast.success(`Moved ${succeeded} task${succeeded === 1 ? '' : 's'}`);
      } else {
        toast.error(`Moved ${succeeded}, ${errorCount} failed${firstError ? ` — ${firstError}` : ''}`);
      }
    },
  });

  // Bulk-patch helper: runs the same PATCH body across every selected task,
  // chunked, invalidates, and reports.
  const bulkPatch = useMutation({
    mutationFn: async ({ ids, body, label }: { ids: string[]; body: Record<string, unknown>; label: string }) => {
      const CHUNK = 8;
      let succeeded = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const results = await Promise.allSettled(
          batch.map((id) => api.patch(`/tasks/${id}`, body)),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') succeeded++;
          else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      }
      return { succeeded, errorCount: errors.length, firstError: errors[0], label };
    },
    onSuccess: ({ succeeded, errorCount, firstError, label }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
      onClearSelection();
      if (errorCount === 0) {
        toast.success(`${label}: ${succeeded} task${succeeded === 1 ? '' : 's'}`);
      } else {
        toast.error(`${label}: ${succeeded} ok, ${errorCount} failed${firstError ? ` — ${firstError}` : ''}`);
      }
    },
  });

  // Bulk label op — attach or detach a single label to/from every selected
  // task. We treat 409 (label already on task / not on task) as success so a
  // user can fire "attach Backend" against a mixed set without partial errors.
  const bulkLabel = useMutation({
    mutationFn: async ({
      ids,
      labelId,
      mode,
    }: {
      ids: string[];
      labelId: string;
      mode: 'attach' | 'detach';
    }) => {
      const CHUNK = 8;
      let succeeded = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const results = await Promise.allSettled(
          batch.map((id) =>
            mode === 'attach'
              ? api.post(`/tasks/${id}/labels/${labelId}`, {})
              : api.delete(`/tasks/${id}/labels/${labelId}`),
          ),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            succeeded++;
          } else {
            const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
            // Idempotent semantics: already-attached / already-detached counts as success.
            if (/already|not found|conflict|409/i.test(msg)) succeeded++;
            else errors.push(msg);
          }
        }
      }
      return { succeeded, errorCount: errors.length, firstError: errors[0], mode };
    },
    onSuccess: ({ succeeded, errorCount, firstError, mode }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
      onClearSelection();
      const verb = mode === 'attach' ? 'Labeled' : 'Unlabeled';
      if (errorCount === 0) {
        toast.success(`${verb}: ${succeeded} task${succeeded === 1 ? '' : 's'}`);
      } else {
        toast.error(
          `${verb}: ${succeeded} ok, ${errorCount} failed${firstError ? ` — ${firstError}` : ''}`,
        );
      }
    },
  });

  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      const CHUNK = 8;
      let succeeded = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const results = await Promise.allSettled(batch.map((id) => api.delete(`/tasks/${id}`)));
        for (const r of results) {
          if (r.status === 'fulfilled') succeeded++;
          else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      }
      return { succeeded, errorCount: errors.length, firstError: errors[0] };
    },
    onSuccess: ({ succeeded, errorCount, firstError }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
      onClearSelection();
      if (errorCount === 0) {
        toast.success(`Deleted ${succeeded} task${succeeded === 1 ? '' : 's'}`);
      } else {
        toast.error(`Deleted ${succeeded}, ${errorCount} failed${firstError ? ` — ${firstError}` : ''}`);
      }
    },
  });

  return { bulkStatusMutation, bulkPatch, bulkLabel, bulkDelete };
}

/**
 * Container that owns the bulk-action mutations (via `useBulkActions`) and
 * renders the floating BulkActionBar. The orchestrator just passes selection
 * state in; everything else lives here.
 */
export function BulkActionsContainer({
  selectedIds,
  statuses,
  projectId,
  sprintsEnabled,
  onClear,
}: {
  selectedIds: Set<string>;
  statuses: string[];
  projectId: string;
  sprintsEnabled: boolean;
  onClear: () => void;
}): JSX.Element | null {
  const { bulkStatusMutation, bulkPatch, bulkLabel, bulkDelete } = useBulkActions({
    projectId,
    onClearSelection: onClear,
  });

  if (selectedIds.size === 0) return null;

  return (
    <BulkActionBar
      count={selectedIds.size}
      statuses={statuses}
      projectId={projectId}
      sprintsEnabled={sprintsEnabled}
      pending={
        bulkStatusMutation.isPending ||
        bulkPatch.isPending ||
        bulkDelete.isPending ||
        bulkLabel.isPending
      }
      onLabel={(labelId, mode) =>
        bulkLabel.mutate({ ids: Array.from(selectedIds), labelId, mode })
      }
      onMove={(status) =>
        bulkStatusMutation.mutate({ ids: Array.from(selectedIds), status })
      }
      onAssign={(assigneeUserId) =>
        bulkPatch.mutate({
          ids: Array.from(selectedIds),
          body: { assigneeUserId },
          label: assigneeUserId === null ? 'Unassigned' : 'Assigned',
        })
      }
      onPriority={(priority) =>
        bulkPatch.mutate({
          ids: Array.from(selectedIds),
          body: { priority },
          label: `Priority → ${priority}`,
        })
      }
      onSprint={(sprintId) =>
        bulkPatch.mutate({
          ids: Array.from(selectedIds),
          body: { sprintId },
          label: sprintId === null ? 'Moved to backlog' : 'Moved to sprint',
        })
      }
      onDelete={() => {
        if (
          window.confirm(
            `Delete ${selectedIds.size} task${selectedIds.size === 1 ? '' : 's'}? This cannot be undone.`,
          )
        ) {
          bulkDelete.mutate(Array.from(selectedIds));
        }
      }}
      onClear={onClear}
    />
  );
}

export function BulkActionBar({
  count,
  statuses,
  projectId,
  sprintsEnabled,
  pending,
  onMove,
  onAssign,
  onPriority,
  onSprint,
  onLabel,
  onDelete,
  onClear,
}: {
  count: number;
  statuses: string[];
  projectId: string;
  sprintsEnabled: boolean;
  pending: boolean;
  onMove: (status: string) => void;
  onAssign: (assigneeUserId: string | null) => void;
  onPriority: (priority: Priority) => void;
  onSprint: (sprintId: string | null) => void;
  /** Attach or detach one label across every selected task. Mode is encoded
   *  in the dropdown's value (e.g. `attach:<id>` / `detach:<id>`). */
  onLabel: (labelId: string, mode: 'attach' | 'detach') => void;
  onDelete: () => void;
  onClear: () => void;
}): JSX.Element {
  const usersQuery = useQuery({
    queryKey: queryKeys.usersList(),
    queryFn: () => api.get<{ items: User[]; nextCursor: string | null }>('/users?limit=100'),
  });
  const sprintsQuery = useQuery({
    queryKey: queryKeys.sprints(projectId),
    queryFn: () => api.get<Array<{ id: string; name: string; state: 'planned' | 'active' | 'completed' }>>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId && sprintsEnabled),
  });
  const labelsQuery = useQuery({
    queryKey: ['labels', projectId],
    queryFn: () => api.get<Array<{ id: string; name: string; color: string }>>(`/projects/${projectId}/labels`),
    enabled: Boolean(projectId),
  });
  const users = usersQuery.data?.items ?? [];
  const sprints = (sprintsQuery.data ?? []).filter((s) => s.state !== 'completed');
  const labels = labelsQuery.data ?? [];

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 animate-popover-in" style={{ transformOrigin: 'bottom center' }}>
      <div className="flex items-center gap-2 rounded-lg bg-card border border-border shadow-xl px-3 py-2 flex-wrap max-w-[min(96vw,900px)]">
        <span className="text-sm font-medium">{count} selected</span>
        <span className="text-muted-foreground text-xs">·</span>

        {/* Status */}
        <BulkSelect
          label="Status"
          disabled={pending}
          onChange={(v) => v && onMove(v)}
          options={[{ value: '', label: '—' }, ...statuses.map((s) => ({ value: s, label: s }))]}
        />

        {/* Priority */}
        <BulkSelect
          label="Priority"
          disabled={pending}
          onChange={(v) => v && onPriority(v as Priority)}
          options={[
            { value: '', label: '—' },
            { value: 'Critical', label: 'Critical' },
            { value: 'High', label: 'High' },
            { value: 'Medium', label: 'Medium' },
            { value: 'Low', label: 'Low' },
          ]}
        />

        {/* Assignee */}
        <BulkSelect
          label="Assignee"
          disabled={pending}
          onChange={(v) => {
            if (v === '') return;
            onAssign(v === '__unassign' ? null : v);
          }}
          options={[
            { value: '', label: '—' },
            { value: '__unassign', label: 'Unassign' },
            ...users.map((u) => ({ value: u.id, label: u.name || u.email })),
          ]}
        />

        {/* Sprint */}
        {sprintsEnabled && (
          <BulkSelect
            label="Sprint"
            disabled={pending}
            onChange={(v) => {
              if (v === '') return;
              onSprint(v === '__backlog' ? null : v);
            }}
            options={[
              { value: '', label: '—' },
              { value: '__backlog', label: 'Move to backlog' },
              ...sprints.map((s) => ({ value: s.id, label: `${s.name} (${s.state})` })),
            ]}
          />
        )}

        {/* Labels — single select with attach/detach prefix on the option value.
            Splitting into two adjacent selects would double the bar's width;
            this keeps it compact while still letting the user remove a label
            from a selection. */}
        {labels.length > 0 && (
          <BulkSelect
            label="Labels"
            disabled={pending}
            onChange={(v) => {
              if (!v) return;
              const [mode, id] = v.split(':');
              if ((mode === 'attach' || mode === 'detach') && id) {
                onLabel(id, mode);
              }
            }}
            options={[
              { value: '', label: '—' },
              ...labels.map((l) => ({ value: `attach:${l.id}`, label: `+ ${l.name}` })),
              ...labels.map((l) => ({ value: `detach:${l.id}`, label: `− ${l.name}` })),
            ]}
          />
        )}

        {/* Delete */}
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          className="tap rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
        >
          Delete
        </button>

        <button
          type="button"
          onClick={onClear}
          disabled={pending}
          aria-label="Clear selection"
          className="tap ml-1 rounded-md w-7 h-7 flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * Inline select used inside the BulkActionBar. Fires onChange on every pick,
 * resetting to '' after so a second pick of the same option still triggers.
 */
function BulkSelect({
  label,
  options,
  disabled,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="relative inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs cursor-pointer hover:bg-accent transition-colors">
      <span className="text-muted-foreground">{label}</span>
      <select
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v);
          e.target.value = '';
        }}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
