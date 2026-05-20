import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Columns3,
  PlusCircle,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { cn, Spinner } from '@nockta/ui';

import { api } from '../../lib/api';

// =============================================================================
// WorkflowStatusesEditor — full CRUD for a project's columns + statuses.
//
// Lives in Project Settings → Workflow. Mirrors the runtime data: columns are
// visual lanes on the board; each column owns 0+ statuses; tasks have a
// status that maps to exactly one column. Renaming a status cascades
// server-side across Task.status + the workflow transition table.
//
// UX
// --
// Two-pane layout: columns on the left, statuses on the right. Selecting a
// column filters the statuses list. Add buttons sit at the top of each pane;
// rename / delete sit inline per row. Initial + Done flags are checkboxes on
// the status row so an admin can read off the headline state at a glance.
//
// Per-call optimistic UX is deliberately avoided here — the data model is
// constrained enough (unique names, status counts) that surfacing the real
// server response is friendlier than rolling back optimistic state on error.
// =============================================================================

interface Column {
  id: string;
  name: string;
  position: number;
  color: string | null;
}

interface Status {
  id: string;
  columnId: string;
  name: string;
  position: number;
  color: string | null;
  isInitialStatus: boolean;
  isDoneStatus: boolean;
}

interface Snapshot {
  columns: Column[];
  statuses: Status[];
}

export function WorkflowStatusesEditor({ projectId }: { projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);

  const snapshotQuery = useQuery<Snapshot>({
    queryKey: ['project-workflow', projectId],
    queryFn: () => api.get<Snapshot>(`/projects/${projectId}/workflow`),
  });

  const columns = snapshotQuery.data?.columns ?? [];
  const statuses = snapshotQuery.data?.statuses ?? [];

  // Auto-select the first column when data first arrives so the right pane
  // isn't empty on initial render.
  if (selectedColumnId === null && columns.length > 0) {
    setSelectedColumnId(columns[0]!.id);
  }

  const statusesInSelectedColumn = useMemo(() => {
    if (!selectedColumnId) return [];
    return statuses
      .filter((s) => s.columnId === selectedColumnId)
      .sort((a, b) => a.position - b.position);
  }, [statuses, selectedColumnId]);

  const refetch = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['project-workflow', projectId] });
    // The board reads /projects/:id/workflow too; invalidate broadly so any
    // mounted board re-renders with the new columns.
    void queryClient.invalidateQueries({ queryKey: ['board-workflow', projectId] });
  };

  // ---- mutations ----

  const createColumn = useMutation({
    mutationFn: (name: string) => api.post<Column>(`/projects/${projectId}/columns`, { name }),
    onSuccess: (col) => {
      toast.success(`Column "${col.name}" added`);
      setSelectedColumnId(col.id);
      refetch();
    },
    onError: (err) => toast.error((err as { message?: string })?.message ?? 'Could not create column'),
  });

  const renameColumn = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<Column>(`/projects/${projectId}/columns/${id}`, { name }),
    onSuccess: () => {
      toast.success('Column renamed');
      refetch();
    },
    onError: (err) => toast.error((err as { message?: string })?.message ?? 'Rename failed'),
  });

  const reorderColumns = useMutation({
    mutationFn: (orderedIds: string[]) =>
      api.put<Column[]>(`/projects/${projectId}/columns/order`, { orderedIds }),
    onSuccess: () => refetch(),
    onError: (err) => toast.error((err as { message?: string })?.message ?? 'Reorder failed'),
  });

  const deleteColumn = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/columns/${id}`),
    onSuccess: () => {
      toast.success('Column deleted');
      setSelectedColumnId((id) => (id === null ? null : columns.find((c) => c.id !== id)?.id ?? null));
      refetch();
    },
    onError: (err) => toast.error((err as { message?: string })?.message ?? 'Delete failed'),
  });

  const createStatus = useMutation({
    mutationFn: (input: { columnId: string; name: string }) =>
      api.post<Status>(`/projects/${projectId}/statuses`, input),
    onSuccess: (s) => {
      toast.success(`Status "${s.name}" added`);
      refetch();
    },
    onError: (err) => toast.error((err as { message?: string })?.message ?? 'Could not create status'),
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Status> }) =>
      api.patch<Status>(`/projects/${projectId}/statuses/${id}`, patch),
    onSuccess: () => refetch(),
    onError: (err) => toast.error((err as { message?: string })?.message ?? 'Update failed'),
  });

  const deleteStatus = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/statuses/${id}`),
    onSuccess: () => {
      toast.success('Status deleted');
      refetch();
    },
    onError: (err) => toast.error((err as { message?: string })?.message ?? 'Delete failed'),
  });

  const resetAll = useMutation({
    mutationFn: () => api.post<Snapshot>(`/projects/${projectId}/workflow/reset`, {}),
    onSuccess: () => {
      toast.success('Workflow reset to preset defaults');
      setSelectedColumnId(null);
      refetch();
    },
    onError: (err) => toast.error((err as { message?: string })?.message ?? 'Reset failed'),
  });

  // ---- handlers ----

  function handleAddColumn(): void {
    const name = window.prompt('Column name (e.g. "Doing")');
    if (name && name.trim()) createColumn.mutate(name.trim());
  }

  function handleRenameColumn(col: Column): void {
    const name = window.prompt('Rename column to:', col.name);
    if (name && name.trim() && name.trim() !== col.name) {
      renameColumn.mutate({ id: col.id, name: name.trim() });
    }
  }

  function handleMoveColumn(idx: number, direction: -1 | 1): void {
    const next = idx + direction;
    if (next < 0 || next >= columns.length) return;
    const ordered = columns.map((c) => c.id);
    [ordered[idx], ordered[next]] = [ordered[next]!, ordered[idx]!];
    reorderColumns.mutate(ordered);
  }

  function handleDeleteColumn(col: Column): void {
    const inColumn = statuses.filter((s) => s.columnId === col.id);
    if (inColumn.length > 0) {
      toast.error(
        `Move or delete the ${inColumn.length} status${inColumn.length === 1 ? '' : 'es'} inside "${col.name}" first.`,
      );
      return;
    }
    if (window.confirm(`Delete column "${col.name}"?`)) {
      deleteColumn.mutate(col.id);
    }
  }

  function handleAddStatus(): void {
    if (!selectedColumnId) {
      toast.error('Pick a column first.');
      return;
    }
    const name = window.prompt('Status name (e.g. "Blocked")');
    if (name && name.trim()) {
      createStatus.mutate({ columnId: selectedColumnId, name: name.trim() });
    }
  }

  function handleRenameStatus(s: Status): void {
    const name = window.prompt(
      `Rename "${s.name}" to:\n\n` +
        '(Tasks currently in this status will be moved to the new name automatically — and workflow transitions referencing the old name will be updated too.)',
      s.name,
    );
    if (name && name.trim() && name.trim() !== s.name) {
      updateStatus.mutate({ id: s.id, patch: { name: name.trim() } });
    }
  }

  function handleMoveStatusColumn(s: Status, columnId: string): void {
    if (columnId === s.columnId) return;
    updateStatus.mutate({ id: s.id, patch: { columnId } });
  }

  function handleToggleInitial(s: Status, next: boolean): void {
    if (next && s.isInitialStatus) return;
    updateStatus.mutate({ id: s.id, patch: { isInitialStatus: next } });
  }

  function handleToggleDone(s: Status, next: boolean): void {
    updateStatus.mutate({ id: s.id, patch: { isDoneStatus: next } });
  }

  function handleDeleteStatus(s: Status): void {
    if (s.isInitialStatus) {
      toast.error('Mark another status as Initial before deleting this one.');
      return;
    }
    if (
      window.confirm(
        `Delete status "${s.name}"?\n\n` +
          'This is blocked if any task is still in this status — move them first.',
      )
    ) {
      deleteStatus.mutate(s.id);
    }
  }

  if (snapshotQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="text-sm" /> Loading workflow…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-3">
        {/* ----- Columns pane ----- */}
        <div className="rounded-md border border-border bg-background/40">
          <header className="flex items-center justify-between px-3 py-2 border-b border-border">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
              <Columns3 className="h-3.5 w-3.5" />
              Columns
            </div>
            <button
              type="button"
              onClick={handleAddColumn}
              className="text-[11px] text-brand hover:underline inline-flex items-center gap-0.5"
            >
              <PlusCircle className="h-3 w-3" /> Add
            </button>
          </header>
          <ul className="divide-y divide-border/70">
            {columns.map((col, idx) => {
              const inCount = statuses.filter((s) => s.columnId === col.id).length;
              const active = col.id === selectedColumnId;
              return (
                <li key={col.id}>
                  <div
                    className={cn(
                      'flex items-center gap-1 px-2 py-1.5 group',
                      active ? 'bg-accent/60' : 'hover:bg-accent/30',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedColumnId(col.id)}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left text-xs"
                    >
                      <ChevronRight
                        className={cn(
                          'h-3 w-3 text-muted-foreground transition-transform',
                          active && 'rotate-90',
                        )}
                      />
                      <span className="font-medium truncate">{col.name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {inCount} status{inCount === 1 ? '' : 'es'}
                      </span>
                    </button>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => handleMoveColumn(idx, -1)}
                        disabled={idx === 0 || reorderColumns.isPending}
                        className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label="Move column up"
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveColumn(idx, 1)}
                        disabled={idx === columns.length - 1 || reorderColumns.isPending}
                        className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label="Move column down"
                      >
                        <ArrowDown className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRenameColumn(col)}
                        className="px-1 text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        rename
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteColumn(col)}
                        className="p-0.5 text-muted-foreground hover:text-destructive"
                        aria-label="Delete column"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
            {columns.length === 0 && (
              <li className="px-3 py-3 text-[11px] text-muted-foreground text-center">
                No columns yet. Add one above.
              </li>
            )}
          </ul>
        </div>

        {/* ----- Statuses pane ----- */}
        <div className="rounded-md border border-border bg-background/40">
          <header className="flex items-center justify-between px-3 py-2 border-b border-border">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {selectedColumnId
                ? `Statuses in "${columns.find((c) => c.id === selectedColumnId)?.name ?? '—'}"`
                : 'Statuses'}
            </div>
            <button
              type="button"
              onClick={handleAddStatus}
              disabled={!selectedColumnId}
              className="text-[11px] text-brand hover:underline disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-0.5"
            >
              <PlusCircle className="h-3 w-3" /> Add status
            </button>
          </header>
          <ul className="divide-y divide-border/70">
            {statusesInSelectedColumn.map((s) => (
              <li key={s.id} className="px-3 py-2 group">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium flex-1 min-w-0 truncate">{s.name}</span>
                  {s.isInitialStatus && (
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-brand/15 text-brand font-semibold">
                      Initial
                    </span>
                  )}
                  {s.isDoneStatus && (
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-status-done/15 text-status-done font-semibold">
                      Done
                    </span>
                  )}
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleRenameStatus(s)}
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      rename
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteStatus(s)}
                      className="text-muted-foreground hover:text-destructive p-0.5"
                      aria-label="Delete status"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 flex items-center flex-wrap gap-3 text-[11px]">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={s.isInitialStatus}
                      onChange={(e) => handleToggleInitial(s, e.target.checked)}
                      className="h-3 w-3 accent-brand cursor-pointer"
                    />
                    <span className="text-muted-foreground">Initial (new tasks start here)</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={s.isDoneStatus}
                      onChange={(e) => handleToggleDone(s, e.target.checked)}
                      className="h-3 w-3 accent-brand cursor-pointer"
                    />
                    <span className="text-muted-foreground">Counts as Done</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <span className="text-muted-foreground">In column:</span>
                    <select
                      value={s.columnId}
                      onChange={(e) => handleMoveStatusColumn(s, e.target.value)}
                      className="rounded-md border border-input bg-background px-1.5 py-0.5 text-[11px]"
                    >
                      {columns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </li>
            ))}
            {selectedColumnId && statusesInSelectedColumn.length === 0 && (
              <li className="px-3 py-3 text-[11px] text-muted-foreground text-center">
                This column has no statuses yet. Add one above.
              </li>
            )}
            {!selectedColumnId && (
              <li className="px-3 py-3 text-[11px] text-muted-foreground text-center">
                Select a column to manage its statuses.
              </li>
            )}
          </ul>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => {
            if (
              window.confirm(
                'Reset columns + statuses + workflow transitions to the preset defaults? ' +
                  'Tasks in custom statuses block this — move them first.',
              )
            ) {
              resetAll.mutate();
            }
          }}
          disabled={resetAll.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset workflow to defaults
        </button>
      </div>
    </div>
  );
}
