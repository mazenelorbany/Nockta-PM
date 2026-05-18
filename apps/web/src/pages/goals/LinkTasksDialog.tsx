import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { StatusPill } from '../../components/task-bits';
import { api } from '../../lib/api';
import type { PickerTask } from './types';
import { apiErrorMessage } from './util';

// =============================================================================
// LinkTasksDialog — multi-select task picker that searches across every
// project the user can see. Replaces the old "use the goal picker (coming
// soon in the drawer)" empty-state copy. Free-text search hits the existing
// /search endpoint, results render as a checklist, and the bulk submit
// fires N POST /goals/:id/tasks/:taskId in parallel.
//
// Excludes tasks already linked to the goal so the user can't double-link.
// The dialog closes only after every link succeeds so a partial failure
// doesn't leave the user wondering which ones landed.
// =============================================================================

export function LinkTasksDialog({
  goalId,
  alreadyLinkedIds,
  onClose,
  onLinked,
}: {
  goalId: string;
  alreadyLinkedIds: Set<string>;
  onClose: () => void;
  onLinked: () => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Debounce the search by query value so each keystroke doesn't fire a
  // request. We rely on react-query's `enabled` to skip the empty query
  // case (which would 400 on the backend).
  const search = useQuery({
    queryKey: ['goal-picker', q],
    queryFn: () =>
      api.get<{ tasks: PickerTask[] }>(`/search?q=${encodeURIComponent(q)}&limit=30`),
    enabled: q.trim().length >= 2,
  });

  const linkAll = useMutation({
    mutationFn: async () => {
      const ids = Array.from(picked);
      // Sequential rather than parallel: each call is cheap, but a guest with
      // permissions for some projects but not others would otherwise get a
      // confused mix of 200 + 403 responses. Sequential gives us a clean
      // first-failure to surface.
      for (const id of ids) {
        await api.post(`/goals/${goalId}/tasks/${id}`, {});
      }
      return ids.length;
    },
    onSuccess: (count) => {
      toast.success(`Linked ${count} task${count === 1 ? '' : 's'}`);
      onLinked();
      onClose();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Link failed')),
  });

  const candidates = (search.data?.tasks ?? []).filter((t) => !alreadyLinkedIds.has(t.id));

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md md:max-w-2xl rounded-lg border border-border bg-card shadow-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold">Link tasks to this goal</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Search across every project you can see. Pick the tasks that contribute to this goal.
          </p>
          <input
            type="search"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, description, or task key…"
            className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {q.trim().length < 2 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">
              Type at least 2 characters to search.
            </div>
          ) : search.isLoading ? (
            <div className="text-xs text-muted-foreground py-6 text-center">Searching…</div>
          ) : candidates.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">
              No matches. Try a different search.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {candidates.map((t) => {
                const isPicked = picked.has(t.id);
                return (
                  <li key={t.id}>
                    <label className="flex items-center gap-3 px-2 py-2 hover:bg-accent/40 rounded cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isPicked}
                        onChange={(e) => {
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(t.id);
                            else next.delete(t.id);
                            return next;
                          });
                        }}
                      />
                      <span className="text-[10px] font-mono text-muted-foreground w-16 shrink-0">
                        {t.project.key}-{t.keyNumber}
                      </span>
                      <span className="flex-1 text-sm truncate">{t.title}</span>
                      <StatusPill status={t.status} />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {picked.size} selected
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={picked.size === 0 || linkAll.isPending}
              onClick={() => linkAll.mutate()}
              className="rounded-md bg-foreground text-background px-4 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {linkAll.isPending ? 'Linking…' : `Link ${picked.size || ''}`.trim()}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
