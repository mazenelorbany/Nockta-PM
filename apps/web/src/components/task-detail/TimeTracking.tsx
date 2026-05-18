import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ChevronDown, Clock, Play, Square, X } from 'lucide-react';
import { cn } from '@nockta/ui';

import { api } from '../../lib/api';

import { PopoverShell } from './pickers/Popover';
import type { WorklogSummary } from './types';
import { apiErrorMessage, formatDuration, usePopover } from './utils';

/**
 * Compact time-tracked chip that opens a ClickUp-style popover for the full
 * timer / manual-entry experience. Was previously a static display tied to a
 * heavy section at the bottom of the drawer — now everything lives inside the
 * popover so the chip in the meta grid is the only entry point.
 */
export function TimeTrackedCompact({
  taskId,
  estimateHours,
}: {
  taskId: string;
  estimateHours: number | null;
}): JSX.Element {
  const pop = usePopover();
  const worklogQuery = useQuery({
    queryKey: ['worklog', taskId],
    queryFn: () => api.get<WorklogSummary>(`/tasks/${taskId}/worklog`),
    refetchInterval: 5_000,
  });
  const summary = worklogQuery.data ?? { entries: [], totalSeconds: 0, running: null };
  const liveSeconds = summary.running
    ? Math.floor((Date.now() - new Date(summary.running.startedAt).getTime()) / 1000)
    : 0;
  const totalLive = summary.totalSeconds + liveSeconds;

  const hours = Math.floor(totalLive / 3600);
  const mins = Math.floor((totalLive % 3600) / 60);
  const display = totalLive === 0
    ? 'Add time'
    : `${hours}h ${String(mins).padStart(2, '0')}m`;
  const overEstimate = estimateHours !== null && totalLive > estimateHours * 3600;
  const running = Boolean(summary.running);

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={pop.toggle}
        data-open={pop.open ? 'true' : 'false'}
        className={cn(
          'tap inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs',
          'hover:bg-accent/50 hover:text-foreground transition-colors',
          'data-[open=true]:bg-accent',
          overEstimate ? 'text-priority-high' : 'text-foreground/90',
          totalLive === 0 && 'text-muted-foreground/80',
        )}
        title={running ? 'Timer running — click to manage' : 'Track time'}
      >
        {running && <span className="h-1.5 w-1.5 rounded-full bg-status-done animate-pulse" />}
        <Play className="h-3 w-3 text-muted-foreground/70" />
        <span className="tabular-nums">{display}</span>
        {estimateHours !== null && totalLive > 0 && (
          <span className="text-muted-foreground/70">/ {estimateHours}h</span>
        )}
      </button>
      <TrackTimePopover
        open={pop.open}
        onClose={pop.close}
        taskId={taskId}
        estimateHours={estimateHours}
      />
    </div>
  );
}

// =============================================================================
// TrackTimePopover — ClickUp-style time tracker. Click trigger to open; modal
// is anchored under the chip. Contains:
//   - Total across the task (with a sub-row if subtasks contribute)
//   - Big "Enter time (ex: 3h 20m) or start timer" input with a play/stop button
//   - Date + time-range display (defaults to now → now)
//   - Optional notes field
//   - Save button for manual entries
//   - Recent entries list (last 5) with one-click delete
// =============================================================================

export function TrackTimePopover({
  open,
  onClose,
  taskId,
  estimateHours,
}: {
  open: boolean;
  onClose: () => void;
  taskId: string;
  estimateHours: number | null;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [showEntries, setShowEntries] = useState(false);

  const worklogQuery = useQuery({
    queryKey: ['worklog', taskId],
    queryFn: () => api.get<WorklogSummary>(`/tasks/${taskId}/worklog`),
    refetchInterval: open ? 1_000 : 5_000,
  });
  const summary = worklogQuery.data ?? { entries: [], totalSeconds: 0, running: null };
  const liveSeconds = summary.running
    ? Math.floor((Date.now() - new Date(summary.running.startedAt).getTime()) / 1000)
    : 0;
  const totalLive = summary.totalSeconds + liveSeconds;
  const isRunning = Boolean(summary.running);

  const startMut = useMutation({
    mutationFn: () => api.post(`/tasks/${taskId}/worklog/start`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worklog', taskId] });
      // Keep the global header chip in lockstep with the per-task view.
      queryClient.invalidateQueries({ queryKey: ['worklog', 'me', 'active'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not start timer')),
  });
  const stopMut = useMutation({
    mutationFn: () => api.post(`/tasks/${taskId}/worklog/stop`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worklog', taskId] });
      queryClient.invalidateQueries({ queryKey: ['worklog', 'me', 'active'] });
      toast.success('Timer stopped');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not stop timer')),
  });
  const logMut = useMutation({
    mutationFn: (input: { seconds: number; note?: string }) =>
      api.post(`/tasks/${taskId}/worklog/log`, input),
    onSuccess: () => {
      toast.success('Time logged');
      setDraft('');
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['worklog', taskId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not log time')),
  });
  const removeMut = useMutation({
    mutationFn: (id: string) => api.delete(`/worklog/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['worklog', taskId] }),
  });

  // Parse "3h 20m" / "1.5h" / "90m" / "45" (minutes) into seconds.
  function parseDuration(s: string): number {
    const trimmed = s.trim().toLowerCase();
    if (!trimmed) return 0;
    let total = 0;
    const hMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*h/);
    const mMatch = trimmed.match(/(\d+)\s*m/);
    if (hMatch) total += Math.floor(parseFloat(hMatch[1]) * 3600);
    if (mMatch) total += parseInt(mMatch[1], 10) * 60;
    if (!hMatch && !mMatch) {
      // Bare number — interpret as minutes (the most common shorthand).
      const n = Number(trimmed);
      if (Number.isFinite(n) && n > 0) total = Math.floor(n * 60);
    }
    return total;
  }

  function submitManual(): void {
    const seconds = parseDuration(draft);
    if (seconds <= 0) {
      toast.error('Enter time like "3h 20m" or "45m"');
      return;
    }
    logMut.mutate({ seconds, ...(note.trim() ? { note: note.trim() } : {}) });
  }

  const now = new Date();
  const fmtTime = (d: Date): string =>
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const fmtDate = (d: Date): string =>
    d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <PopoverShell open={open} onClose={onClose} align="left" className="w-[360px] p-0">
      {/* Header — total time on this task + subtotal */}
      <div className="px-4 pt-3 pb-2 space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium">Time on this task</span>
          <span className="font-mono tabular-nums text-foreground">
            {formatDuration(totalLive)}
          </span>
        </div>
        {estimateHours !== null && (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Estimate
            </span>
            <span className="tabular-nums">{estimateHours}h</span>
          </div>
        )}
      </div>

      <div className="border-t border-border" />

      {/* Time input + start/stop */}
      <div className="px-4 py-3 space-y-3">
        <div className="flex items-center gap-2">
          {isRunning ? (
            <>
              <div className="flex-1 min-w-0 rounded-md border border-status-done/40 bg-status-done/10 px-3 py-2 text-xs text-status-done flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-status-done animate-pulse" />
                <span className="font-mono tabular-nums">{formatDuration(liveSeconds)}</span>
                <span className="text-muted-foreground">running…</span>
              </div>
              <button
                type="button"
                onClick={() => stopMut.mutate()}
                disabled={stopMut.isPending}
                className="tap inline-flex items-center justify-center w-9 h-9 rounded-full bg-status-blocked text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
                aria-label="Stop timer"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitManual();
                  }
                }}
                placeholder="Enter time (ex: 3h 20m) or start timer"
                className="field text-xs py-2 flex-1 min-w-0"
              />
              <button
                type="button"
                onClick={() => startMut.mutate()}
                disabled={startMut.isPending}
                className="tap inline-flex items-center justify-center w-9 h-9 rounded-full bg-foreground text-background hover:opacity-90 disabled:opacity-50 transition-opacity"
                aria-label="Start timer"
              >
                <Play className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>

        {/* Date + time range (read-only display — we always log from current
            session timestamps; future iteration can make these editable). */}
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span>{fmtDate(now)}</span>
          <span className="font-mono tabular-nums">{fmtTime(now)}</span>
          <span>–</span>
          <span className="font-mono tabular-nums">{fmtTime(now)}</span>
        </div>

        {/* Notes — only shown when entering manual time */}
        {!isRunning && (
          <div className="flex items-start gap-2">
            <span className="text-muted-foreground mt-1.5">≡</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Notes"
              className="field text-xs py-1.5 flex-1 min-w-0 border-transparent hover:border-input focus:border-input"
            />
          </div>
        )}

        {/* Save manual entry */}
        {!isRunning && (
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={submitManual}
              disabled={!draft.trim() || logMut.isPending}
              className="tap rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {logMut.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {/* Recent entries — toggle */}
      {summary.entries.length > 0 && (
        <>
          <div className="border-t border-border" />
          <button
            type="button"
            onClick={() => setShowEntries((v) => !v)}
            className="w-full px-4 py-2 flex items-center justify-between text-[11px] text-muted-foreground hover:text-foreground"
          >
            <span>{summary.entries.length} entries</span>
            <ChevronDown className={cn('h-3 w-3 transition-transform', showEntries && 'rotate-180')} />
          </button>
          {showEntries && (
            <ul className="px-2 pb-2 max-h-48 overflow-y-auto space-y-0.5">
              {summary.entries.slice(0, 20).map((e) => (
                <li key={e.id} className="group flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/40">
                  <span className="font-mono tabular-nums w-14">{formatDuration(e.seconds)}</span>
                  <span className="text-muted-foreground text-[10px]">
                    {new Date(e.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                  {e.note && <span className="truncate flex-1 text-muted-foreground">{e.note}</span>}
                  <button
                    type="button"
                    onClick={() => removeMut.mutate(e.id)}
                    aria-label="Delete entry"
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PopoverShell>
  );
}
