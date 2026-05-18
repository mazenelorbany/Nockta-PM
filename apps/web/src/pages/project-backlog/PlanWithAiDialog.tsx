import { useMutation, useQuery } from '@tanstack/react-query';
import { Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';

import { PriorityDot, type Priority } from '../../components/task-bits';
import { api } from '../../lib/api';

import { apiErrorMessage } from './helpers';
import type { CapacityResponse, PlanResponse, Sprint } from './types';

// =============================================================================
// PlanWithAiDialog — opens when the user clicks "Plan with AI" on a planned
// sprint. Asks the API for:
//   1. A capacity recommendation (from analytics velocity history).
//   2. A ranked task list that fits inside that capacity.
//
// User flow:
//   - Capacity slider, defaults to the AI-recommended number.
//   - Table of ranked backlog tasks with per-row accept toggles. Default ALL
//     ranked tasks are accepted.
//   - "Move to sprint" button POSTs each accepted task into the target sprint.
// =============================================================================

export function PlanWithAiDialog({
  projectId,
  sprint,
  onClose,
  onAccepted,
}: {
  projectId: string;
  sprint: Sprint;
  onClose: () => void;
  onAccepted: () => void;
}): JSX.Element {
  // Capacity recommendation — read-only velocity math, no LLM hop.
  const capacityQuery = useQuery<CapacityResponse>({
    queryKey: ['ai-sprint-capacity', projectId],
    queryFn: () => api.get<CapacityResponse>(`/ai/projects/${projectId}/sprint-capacity`),
  });

  const [capacity, setCapacity] = useState<number | null>(null);
  // Once the capacity recommendation arrives, seed the slider with it. We
  // keep the local state so the user can tweak before fetching the ranked list.
  useEffect(() => {
    if (capacity == null && capacityQuery.data) {
      setCapacity(capacityQuery.data.suggestedPoints);
    }
  }, [capacityQuery.data, capacity]);

  // Ranked tasks — only fires once we have a concrete capacity. The endpoint
  // computes the greedy fill in-process; the response shape is what we render.
  const planQuery = useQuery<PlanResponse>({
    queryKey: ['ai-plan-sprint', projectId, capacity],
    enabled: capacity != null && capacity > 0,
    queryFn: () =>
      api.post<PlanResponse>(`/ai/projects/${projectId}/plan-sprint`, { capacity }),
  });

  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (planQuery.data) {
      // Default all ranked tasks to accepted — the PM can untick individual
      // rows but the common case is "yes, let's do this".
      setAccepted(new Set(planQuery.data.tasks.map((t) => t.taskId)));
    }
  }, [planQuery.data]);

  const moveMutation = useMutation({
    mutationFn: async (taskIds: string[]) => {
      // Move each accepted task into the sprint. We hit the existing
      // /tasks/:id PATCH endpoint per task — fine for the small N typical of
      // a sprint plan (<30 tasks).
      await Promise.all(
        taskIds.map((id) =>
          api.patch(`/tasks/${id}`, { sprintId: sprint.id }),
        ),
      );
    },
    onSuccess: () => {
      toast.success(`Moved ${accepted.size} task${accepted.size === 1 ? '' : 's'} to ${sprint.name}`);
      onAccepted();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not apply AI plan')),
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-lg border border-border bg-card shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand" />
          <h2 className="text-lg font-semibold">Plan with AI · {sprint.name}</h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-6 py-4 space-y-4 overflow-y-auto">
          {/* Capacity row */}
          {capacityQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Computing capacity from history…</div>
          ) : capacityQuery.data ? (
            <div className="rounded-md border border-border bg-background/40 p-3">
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <div className="text-sm font-semibold">Capacity</div>
                <div className="text-[10px] text-muted-foreground">
                  Range {capacityQuery.data.lowerBound}–{capacityQuery.data.upperBound} pts ·
                  sample {capacityQuery.data.sampleSize} sprint{capacityQuery.data.sampleSize === 1 ? '' : 's'}
                </div>
              </div>
              <input
                type="range"
                min={1}
                max={Math.max(capacityQuery.data.upperBound, capacityQuery.data.suggestedPoints) * 2}
                value={capacity ?? capacityQuery.data.suggestedPoints}
                onChange={(e) => setCapacity(Number(e.target.value))}
                className="w-full accent-brand"
              />
              <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                <span className="font-mono text-foreground">{capacity ?? capacityQuery.data.suggestedPoints} pts</span>
                <span>·</span>
                <span>{capacityQuery.data.explanation}</span>
              </div>
            </div>
          ) : null}

          {/* Ranked list */}
          {planQuery.isLoading && (
            <div className="text-sm text-muted-foreground">Ranking backlog…</div>
          )}
          {planQuery.data && (
            <div className="rounded-md border border-border">
              <div className="flex items-baseline justify-between px-3 py-2 border-b border-border bg-background/40">
                <div className="text-xs text-muted-foreground">
                  AI suggests {planQuery.data.tasks.length} tasks ·
                  fills {planQuery.data.usedPoints}/{planQuery.data.capacity} pts
                </div>
                <div className="text-[10px] text-muted-foreground font-mono">
                  {accepted.size} accepted
                </div>
              </div>
              {planQuery.data.tasks.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No backlog tasks fit this capacity. Estimate more tasks or raise the cap.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {planQuery.data.tasks.map((t) => {
                    const isAccepted = accepted.has(t.taskId);
                    return (
                      <li
                        key={t.taskId}
                        className={cn(
                          'flex items-center gap-3 px-3 py-2 text-sm',
                          !isAccepted && 'opacity-50',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={isAccepted}
                          onChange={(e) => {
                            setAccepted((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(t.taskId);
                              else next.delete(t.taskId);
                              return next;
                            });
                          }}
                          className="h-3.5 w-3.5 accent-brand"
                        />
                        <PriorityDot priority={t.priority as Priority} />
                        <span className="font-mono text-[10px] text-muted-foreground">{t.key}</span>
                        <span className="flex-1 truncate">{t.title}</span>
                        <span className="text-[10px] font-mono text-muted-foreground">{t.storyPoints} pts</span>
                        <span
                          className="text-[10px] text-muted-foreground hidden md:inline"
                          title={`Score ${t.score} · ${t.ageDays}d old`}
                        >
                          {t.why}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        <footer className="px-6 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={accepted.size === 0 || moveMutation.isPending}
            onClick={() => moveMutation.mutate(Array.from(accepted))}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {moveMutation.isPending ? 'Moving…' : `Move ${accepted.size} to sprint`}
          </button>
        </footer>
      </div>
    </div>
  );
}
