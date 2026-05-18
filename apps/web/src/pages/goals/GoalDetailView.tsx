import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useNavigate } from 'react-router-dom';
import { cn } from '@nockta/ui';
import {
  AvatarCircle,
  BlockedBadge,
  DueDateChip,
  PriorityDot,
  StatusPill,
} from '../../components/task-bits';
import { api } from '../../lib/api';
import { GoalStatusPill } from './GoalStatusPill';
import { KeyResultsCard } from './KeyResultsCard';
import { LinkTasksDialog } from './LinkTasksDialog';
import type { GoalDetail, GoalStatus, KeyResult } from './types';
import { apiErrorMessage, krPercent } from './util';

export function GoalDetailView({ goalId }: { goalId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const goalQuery = useQuery({
    queryKey: ['goal', goalId],
    queryFn: () => api.get<GoalDetail>(`/goals/${goalId}`),
  });
  const krQuery = useQuery({
    queryKey: ['goal', goalId, 'key-results'],
    queryFn: () => api.get<KeyResult[]>(`/goals/${goalId}/key-results`),
  });

  const update = useMutation({
    mutationFn: (patch: Partial<GoalDetail>) => api.patch(`/goals/${goalId}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goal', goalId] }),
    onError: (err) => toast.error(apiErrorMessage(err, 'Update failed')),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/goals/${goalId}`),
    onSuccess: () => {
      toast.success('Goal deleted');
      navigate('/goals');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Delete failed')),
  });
  const unlinkTask = useMutation({
    mutationFn: (taskId: string) => api.delete(`/goals/${goalId}/tasks/${taskId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goal', goalId] }),
    onError: (err) => toast.error(apiErrorMessage(err, 'Unlink failed')),
  });

  if (goalQuery.isLoading || !goalQuery.data) {
    return <div className="p-4 sm:p-6 md:p-8 text-muted-foreground">Loading…</div>;
  }
  const goal = goalQuery.data;
  const keyResults = krQuery.data ?? [];

  // Progress rollup priority:
  //   1. Explicit `goal.progress` override if set (manual entry wins).
  //   2. Mean of all key-result percentages when KRs exist (clamped 0–100).
  //   3. Otherwise derive from linked-task done ratio.
  const linkedTasks = goal.tasks.map((gt) => gt.task);
  const doneCount = linkedTasks.filter((t) => t.status === 'Done').length;
  const taskPct = linkedTasks.length === 0 ? 0 : Math.round((doneCount / linkedTasks.length) * 100);
  const krMeanPct = keyResults.length === 0
    ? null
    : Math.round(
        keyResults.reduce((sum, kr) => sum + krPercent(kr), 0) / keyResults.length,
      );
  const pct = goal.progress ?? krMeanPct ?? taskPct;
  const progressSource =
    goal.progress !== null
      ? 'manual'
      : krMeanPct !== null
        ? 'kr'
        : 'tasks';

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-4 sm:py-5 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-baseline gap-2 sm:gap-3 flex-wrap min-w-0">
          <Link to="/goals" className="text-xs text-muted-foreground hover:text-foreground shrink-0">
            ← Goals
          </Link>
          <h1 className="text-lg sm:text-xl font-semibold tracking-tight truncate">{goal.name}</h1>
          <GoalStatusPill status={goal.status} />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={goal.status}
            onChange={(e) => update.mutate({ status: e.target.value as GoalStatus })}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-xs"
          >
            <option value="active">Active</option>
            <option value="achieved">Achieved</option>
            <option value="dropped">Dropped</option>
          </select>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Delete "${goal.name}"?`)) remove.mutate();
            }}
            className="rounded-md px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
          >
            Delete
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 sm:p-6 md:p-8 space-y-4 sm:space-y-6 max-w-4xl">
        {/* Progress bar */}
        <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-3 mb-2">
            <div>
              <div className="nockta-eyebrow text-muted-foreground">Progress</div>
              <div className="text-3xl font-bold tabular-nums">{pct}%</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {progressSource === 'manual' && 'Manual override'}
                {progressSource === 'kr' &&
                  `Mean of ${keyResults.length} key result${keyResults.length === 1 ? '' : 's'}`}
                {progressSource === 'tasks' &&
                  `Auto from linked tasks (${doneCount}/${linkedTasks.length} done)`}
              </div>
            </div>
            <div className="sm:text-right text-xs text-muted-foreground space-y-0.5">
              {goal.startDate && <div>Start · {new Date(goal.startDate).toLocaleDateString()}</div>}
              {goal.targetDate && (
                <div>Target · {new Date(goal.targetDate).toLocaleDateString()}</div>
              )}
              <div className="flex items-center gap-1.5 sm:justify-end pt-1">
                <AvatarCircle user={goal.owner} size={18} />
                {goal.owner.name}
              </div>
            </div>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                'h-full transition-all',
                goal.status === 'achieved' ? 'bg-status-done' : 'bg-brand',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Key results — measurable sub-targets under the goal. Each KR has
            its own progress bar; the goal's rollup percentage uses the mean
            of these unless a manual override is set. */}
        <KeyResultsCard goalId={goalId} keyResults={keyResults} />

        {/* Description */}
        {goal.description && (
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="nockta-eyebrow text-muted-foreground mb-2">Description</div>
            <p className="text-sm whitespace-pre-wrap">{goal.description}</p>
          </div>
        )}

        {/* Linked tasks */}
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-baseline justify-between mb-3 gap-2">
            <h2 className="text-sm font-semibold">Linked tasks ({linkedTasks.length})</h2>
            <div className="flex items-center gap-3">
              <span className="nockta-eyebrow text-muted-foreground">
                {doneCount} done · {linkedTasks.length - doneCount} open
              </span>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent transition-colors"
              >
                <Plus className="h-3 w-3" />
                Link tasks
              </button>
            </div>
          </div>
          {linkedTasks.length === 0 ? (
            <div className="text-xs text-muted-foreground py-3">
              No tasks linked yet. Click <span className="text-foreground">Link tasks</span> above
              to search across your projects and attach work that contributes to this goal.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {linkedTasks.map((t) => (
                <li
                  key={t.id}
                  className="group flex flex-wrap items-center gap-2 sm:gap-3 rounded-md border border-border bg-background/40 hover:bg-background hover:border-ring transition-colors px-3 py-2 text-sm"
                >
                  <PriorityDot priority={t.priority} />
                  <Link
                    to={`/projects/${t.project.id}/board?task=${t.id}`}
                    className="flex flex-wrap items-center gap-2 sm:gap-3 flex-1 min-w-0"
                  >
                    <span className="text-[11px] font-mono text-muted-foreground shrink-0 w-16">
                      {t.project.key}-{t.keyNumber}
                    </span>
                    <span className="flex-1 min-w-0 truncate basis-full sm:basis-auto">{t.title}</span>
                    <BlockedBadge blocked={t.isBlocked} />
                    <DueDateChip dueDate={t.dueDate} done={t.status === 'Done'} />
                    <StatusPill status={t.status} />
                  </Link>
                  <button
                    type="button"
                    onClick={() => unlinkTask.mutate(t.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive text-xs shrink-0"
                  >
                    Unlink
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {pickerOpen && (
        <LinkTasksDialog
          goalId={goalId}
          alreadyLinkedIds={new Set(linkedTasks.map((t) => t.id))}
          onClose={() => setPickerOpen(false)}
          onLinked={() => {
            void queryClient.invalidateQueries({ queryKey: ['goal', goalId] });
          }}
        />
      )}
    </div>
  );
}
