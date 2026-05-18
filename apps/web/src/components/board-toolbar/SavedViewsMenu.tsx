import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, BookmarkPlus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';
import { PromptDialog } from '../dialogs';
import { queryKeys } from '../../lib/query-keys';

import type { BoardView, SavedView, TaskFilters } from './types';

// =============================================================================
// Saved views — let users persist filter + view combinations and quickly switch.
// =============================================================================

export function SavedViewsMenu({
  projectId,
  currentFilters,
  currentView,
  onApply,
}: {
  projectId?: string | undefined;
  currentFilters: TaskFilters;
  currentView: BoardView;
  onApply: (s: SavedView) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const viewsQuery = useQuery({
    queryKey: queryKeys.savedViews(),
    queryFn: () => api.get<SavedView[]>('/saved-views'),
  });
  // On a single-project board, only show views saved for that project. On a
  // workspace-scope board (projectId undefined), show every workspace view —
  // a saved view without a projectId is a "workspace dashboard".
  const myProjectViews = (viewsQuery.data ?? []).filter(
    (v) => !projectId || v.query.projectId === projectId || !v.query.projectId,
  );

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      api.post<SavedView>('/saved-views', {
        name,
        query: { projectId, filters: currentFilters, view: currentView },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.savedViews() });
      toast.success('View saved');
    },
    onError: () => toast.error('Could not save view'),
  });
  // Overwrites an existing view with the current filter + view (keeps the
  // original name and project scope). The "save changes" affordance.
  const overwriteMutation = useMutation({
    mutationFn: (view: SavedView) =>
      api.patch<SavedView>(`/saved-views/${view.id}`, {
        query: {
          projectId: view.query.projectId ?? projectId,
          filters: currentFilters,
          view: currentView,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.savedViews() });
      toast.success('View updated');
    },
    onError: () => toast.error('Could not update view'),
  });
  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<SavedView>(`/saved-views/${id}`, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.savedViews() });
      toast.success('Renamed');
    },
    onError: () => toast.error('Could not rename view'),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/saved-views/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.savedViews() });
    },
  });

  // Modal state for naming a view (save) or renaming one. A single dialog
  // covers both flows so we don't ship two near-identical components — and
  // both replace the native window.prompt() that used to fire here.
  const [nameDialog, setNameDialog] = useState<
    | { kind: 'save' }
    | { kind: 'rename'; viewId: string; currentName: string }
    | null
  >(null);

  const handleSave = () => {
    setOpen(false);
    setNameDialog({ kind: 'save' });
  };

  const handleNameDialogSubmit = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (nameDialog?.kind === 'save') {
      createMutation.mutate(trimmed);
    } else if (nameDialog?.kind === 'rename') {
      if (trimmed !== nameDialog.currentName) {
        renameMutation.mutate({ id: nameDialog.viewId, name: trimmed });
      }
    }
    setNameDialog(null);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="tap inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
      >
        <Bookmark className="h-3 w-3" />
        Views
        {myProjectViews.length > 0 && (
          <span className="ml-1 rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">{myProjectViews.length}</span>
        )}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default bg-transparent"
          />
          <div
            className="animate-popover-in absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-border bg-popover shadow-xl"
            style={{ transformOrigin: 'top right' }}
          >
            <header className="border-b border-border px-3 py-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Saved views
            </header>
            <ul className="max-h-72 overflow-y-auto py-1">
              {myProjectViews.length === 0 && (
                <li className="px-3 py-3 text-xs text-muted-foreground">
                  No saved views yet. Configure filters and save the current
                  combination below.
                </li>
              )}
              {myProjectViews.map((v) => (
                <li key={v.id} className="group flex items-stretch gap-1 px-2 py-1 text-sm hover:bg-muted/40 rounded">
                  <button
                    type="button"
                    onClick={() => {
                      onApply(v);
                      setOpen(false);
                    }}
                    className="flex-1 min-w-0 flex items-center gap-2 px-1.5 py-1 text-left"
                  >
                    <Bookmark className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="truncate">{v.name}</span>
                    {!v.query.projectId && (
                      <span className="ml-1 rounded bg-brand/15 px-1 py-px text-[9px] font-medium uppercase tracking-wider text-brand">
                        Workspace
                      </span>
                    )}
                  </button>
                  <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => overwriteMutation.mutate(v)}
                      className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                      aria-label="Update with current filters"
                      title="Update with current filters"
                    >
                      <BookmarkPlus className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        setNameDialog({ kind: 'rename', viewId: v.id, currentName: v.name });
                      }}
                      className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-[10px] font-bold"
                      aria-label="Rename view"
                      title="Rename view"
                    >
                      Aa
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`Delete view "${v.name}"?`)) deleteMutation.mutate(v.id);
                      }}
                      className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                      aria-label="Delete saved view"
                      title="Delete view"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <footer className="border-t border-border p-2">
              <button
                type="button"
                onClick={handleSave}
                className="tap inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
              >
                <BookmarkPlus className="h-3.5 w-3.5" />
                Save current as new view
              </button>
              <p className="mt-1.5 text-[10px] text-muted-foreground/70 text-center leading-relaxed">
                Hover a view to <span className="text-foreground">update</span>,{' '}
                <span className="text-foreground">rename</span>, or{' '}
                <span className="text-foreground">delete</span>.
              </p>
            </footer>
          </div>
        </>
      )}
      {nameDialog && (
        <PromptDialog
          title={nameDialog.kind === 'save' ? 'Save view' : 'Rename view'}
          body="Give it a short, memorable name."
          submitLabel={nameDialog.kind === 'save' ? 'Save view' : 'Rename'}
          defaultValue={nameDialog.kind === 'rename' ? nameDialog.currentName : ''}
          placeholder="e.g. My open bugs"
          onCancel={() => setNameDialog(null)}
          onSubmit={handleNameDialogSubmit}
        />
      )}
    </div>
  );
}
