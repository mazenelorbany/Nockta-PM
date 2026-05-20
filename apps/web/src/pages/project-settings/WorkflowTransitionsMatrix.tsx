import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ArrowRight, RotateCcw, Save } from 'lucide-react';
import { cn, Spinner } from '@nockta/ui';

import { api } from '../../lib/api';

// =============================================================================
// WorkflowTransitionsMatrix — the "Allowed transitions" matrix for one project.
//
// Surfaces the directed graph that `changeStatus` enforces. Each row is a
// from-status; each column is a to-status; a checked cell means
// "X → Y is allowed". The diagonal is always disabled (a status flipping to
// itself is a no-op, not a transition).
//
// Two save shapes:
//   • PUT /projects/:id/workflow-transitions { transitions: [{from,to}] }
//     — full set replacement. Empty arrays are accepted on purpose (an admin
//     who wants to freeze every task in place can clear the matrix).
//   • POST /projects/:id/workflow-transitions/reset
//     — restore the preset's defaults.
//
// Pending edits are kept in local state and only flushed on Save, so a stray
// click doesn't reset the running gate before the user is sure.
// =============================================================================

// Mirrors the backend `WORKFLOW_STATUSES` constant — kept inline here because
// the alternative (an extra API call to read it) adds latency for what is
// effectively a frozen string list per preset.
const STATUSES_BY_PRESET: Record<'engineering' | 'design' | 'generic', readonly string[]> = {
  engineering: ['Todo', 'In Progress', 'In Review', 'Testing', 'Done'],
  design:      ['Todo', 'In Progress', 'In Review', 'Approved', 'Done'],
  generic:     ['Todo', 'In Progress', 'Done'],
};

interface TransitionRow {
  id?: string;
  fromStatus: string;
  toStatus: string;
}

function key(from: string, to: string): string {
  return `${from}→${to}`;
}

export function WorkflowTransitionsMatrix({
  projectId,
  workflowPreset,
}: {
  projectId: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
}): JSX.Element {
  const queryClient = useQueryClient();
  const statuses = STATUSES_BY_PRESET[workflowPreset];

  const transitionsQuery = useQuery({
    queryKey: ['project-workflow-transitions', projectId],
    queryFn: () => api.get<TransitionRow[]>(`/projects/${projectId}/workflow-transitions`),
  });

  // Local edit buffer keyed by "from→to". When the saved set arrives we seed
  // the buffer; subsequent toggles diff against this until the user hits Save.
  const [pendingEdges, setPendingEdges] = useState<Set<string> | null>(null);
  const savedEdges = useMemo(() => {
    if (!transitionsQuery.data) return null;
    return new Set(transitionsQuery.data.map((t) => key(t.fromStatus, t.toStatus)));
  }, [transitionsQuery.data]);

  // Seed the buffer once on first load; resetting the matrix updates the
  // saved set, and the next effect tick reseeds with the new defaults.
  useEffect(() => {
    if (savedEdges && pendingEdges === null) {
      setPendingEdges(new Set(savedEdges));
    }
  }, [savedEdges, pendingEdges]);

  const dirty = useMemo(() => {
    if (!pendingEdges || !savedEdges) return false;
    if (pendingEdges.size !== savedEdges.size) return true;
    for (const k of pendingEdges) if (!savedEdges.has(k)) return true;
    return false;
  }, [pendingEdges, savedEdges]);

  const save = useMutation({
    mutationFn: (next: Set<string>) =>
      api.put<TransitionRow[]>(`/projects/${projectId}/workflow-transitions`, {
        transitions: Array.from(next).map((k2) => {
          const [fromStatus, toStatus] = k2.split('→');
          return { fromStatus, toStatus };
        }),
      }),
    onSuccess: (rows) => {
      toast.success(`Saved ${rows.length} allowed transition${rows.length === 1 ? '' : 's'}`);
      queryClient.setQueryData(['project-workflow-transitions', projectId], rows);
      // The /board status picker reads this set too — let any open picker
      // re-fetch by invalidating its key family if one is in flight.
      void queryClient.invalidateQueries({ queryKey: ['project-workflow-transitions', projectId] });
    },
    onError: (err) => {
      const msg = (err as { message?: string })?.message ?? 'Could not save';
      toast.error(msg);
    },
  });

  const reset = useMutation({
    mutationFn: () => api.post<TransitionRow[]>(`/projects/${projectId}/workflow-transitions/reset`, {}),
    onSuccess: (rows) => {
      toast.success('Reset to defaults');
      queryClient.setQueryData(['project-workflow-transitions', projectId], rows);
      setPendingEdges(new Set(rows.map((t) => key(t.fromStatus, t.toStatus))));
    },
    onError: (err) => {
      const msg = (err as { message?: string })?.message ?? 'Could not reset';
      toast.error(msg);
    },
  });

  function toggle(from: string, to: string): void {
    if (from === to) return; // self-edges are no-ops; matrix renders them disabled.
    setPendingEdges((prev) => {
      const next = new Set(prev ?? []);
      const k = key(from, to);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function discard(): void {
    if (savedEdges) setPendingEdges(new Set(savedEdges));
  }

  if (transitionsQuery.isLoading || !pendingEdges) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="text-sm" /> Loading transitions…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-background/40 overflow-x-auto">
        <table className="text-xs min-w-full">
          <thead>
            <tr className="border-b border-border bg-background/60">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground sticky left-0 bg-background/80 backdrop-blur">
                From ↓ / To →
              </th>
              {statuses.map((s) => (
                <th key={s} className="px-2 py-2 font-medium text-muted-foreground whitespace-nowrap text-center min-w-[88px]">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {statuses.map((from) => (
              <tr key={from} className="border-b border-border/60 last:border-b-0">
                <th
                  scope="row"
                  className="text-left px-3 py-1.5 font-medium whitespace-nowrap sticky left-0 bg-background/60 backdrop-blur"
                >
                  {from}
                </th>
                {statuses.map((to) => {
                  const isSelf = from === to;
                  const checked = pendingEdges.has(key(from, to));
                  return (
                    <td key={to} className="text-center px-2 py-1.5">
                      {isSelf ? (
                        <span className="text-muted-foreground/40 text-[10px]">—</span>
                      ) : (
                        <label className="inline-flex items-center justify-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(from, to)}
                            className="h-3.5 w-3.5 accent-brand cursor-pointer"
                            aria-label={`Allow ${from} to ${to}`}
                          />
                        </label>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Each checked cell allows that <span className="font-mono">from → to</span> status flip. Uncheck a
        cell to block it — the board and the task drawer will refuse the transition with a tooltip explaining why.
        Backward steps (e.g. <span className="font-mono">In Progress → Todo</span>) are usually worth keeping
        on so a mis-click is undoable.
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => pendingEdges && save.mutate(pendingEdges)}
          disabled={!dirty || save.isPending}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background',
            'hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity',
          )}
        >
          <Save className="h-3.5 w-3.5" />
          {save.isPending ? 'Saving…' : 'Save transitions'}
        </button>
        <button
          type="button"
          onClick={discard}
          disabled={!dirty || save.isPending}
          className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Discard changes
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Reset allowed transitions to the workflow preset defaults?')) {
              reset.mutate();
            }
          }}
          disabled={reset.isPending || save.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset to defaults
        </button>
      </div>

      {/* Helpful preview: the smallest "Todo → Done" sentinel rendered as
          either ✓ or ✗ so an admin sees their intent reflected without
          scanning the whole matrix. */}
      <div className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5 rounded border border-border bg-background/40 px-2 py-1">
        <span className="font-mono">Todo</span>
        <ArrowRight className="h-3 w-3" />
        <span className="font-mono">{statuses[statuses.length - 1]}</span>
        <span className="text-foreground/70">jump:</span>
        <span
          className={cn(
            'font-semibold',
            pendingEdges.has(key('Todo', statuses[statuses.length - 1] ?? 'Done'))
              ? 'text-status-blocked'
              : 'text-status-done',
          )}
        >
          {pendingEdges.has(key('Todo', statuses[statuses.length - 1] ?? 'Done')) ? 'Allowed' : 'Blocked'}
        </span>
      </div>
    </div>
  );
}
