import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { cn } from '@nockta/ui';
import { api } from '../lib/api';
import {
  formatPomodoroTime,
  phaseLabel,
  usePomodoro,
  type PomodoroEvent,
} from '../hooks/usePomodoro';

// =============================================================================
// ActiveTimerChip — header chip that surfaces the user's currently-running
// worklog timer across every page. Hydrates from `GET /worklog/me/active` on
// mount, so a hard reload (or a different browser session) still picks up the
// timer that was running server-side.
//
// Polling fallback for the elapsed counter — the data query has a 1s interval
// while a timer is running and a 30s interval otherwise. Realtime push from
// the worklog events bus would be a future upgrade.
// =============================================================================

interface ActiveTimer {
  id: string;
  taskId: string;
  startedAt: string;
  note: string | null;
  task: {
    id: string;
    title: string;
    projectId: string;
    key: string;
  };
}

/**
 * Minimal shape we read from /users/me/preferences. ProfileTab owns the full
 * preferences interface — duplicated here so we don't reach across files for
 * one boolean (and because the SDK doesn't yet code-gen this DTO).
 */
interface PomodoroPreferences {
  pomodoroEnabled: boolean;
}

export function ActiveTimerChip(): JSX.Element | null {
  const queryClient = useQueryClient();
  const activeQuery = useQuery({
    queryKey: ['worklog', 'me', 'active'],
    queryFn: () => api.get<ActiveTimer | null>('/worklog/me/active'),
    // Server is the source of truth — refetch aggressively while a timer is
    // running so the chip stays current after a tab focus change without
    // relying on socket plumbing.
    refetchInterval: (q) => (q.state.data ? 5_000 : 30_000),
    // On window focus retake the source of truth (e.g. the user stopped the
    // timer on another tab/device).
    refetchOnWindowFocus: true,
  });
  const active = activeQuery.data ?? null;

  // Pomodoro opt-in. The query lives in ProfileTab too — same key so the two
  // share a cache entry.
  const prefsQuery = useQuery({
    queryKey: ['me', 'preferences'],
    queryFn: () => api.get<PomodoroPreferences>('/users/me/preferences'),
    staleTime: 60_000,
  });
  const pomodoroEnabled = prefsQuery.data?.pomodoroEnabled ?? false;

  // Local 1Hz tick so the elapsed label updates without thrashing the query.
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const stopMut = useMutation({
    mutationFn: (taskId: string) => api.post(`/tasks/${taskId}/worklog/stop`),
    onSuccess: (_, taskId) => {
      void queryClient.invalidateQueries({ queryKey: ['worklog', 'me', 'active'] });
      void queryClient.invalidateQueries({ queryKey: ['worklog', taskId] });
      toast.success('Timer stopped');
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError
          ? err.problem.title || err.message
          : 'Could not stop timer',
      ),
  });

  // Track the active task id in a ref so the pomodoro phase-change handler
  // can call /worklog/stop with the right id without re-binding on every
  // render. Storing the ref outside the conditional below keeps the hook
  // call order stable across renders (pomodoro mode toggling off mid-session
  // still must call usePomodoro — React's rules-of-hooks doesn't accept
  // returning early before a hook call).
  const activeTaskIdRef = useRef<string | null>(active?.taskId ?? null);
  useEffect(() => {
    activeTaskIdRef.current = active?.taskId ?? null;
  }, [active?.taskId]);

  function handlePhaseChange(ev: PomodoroEvent): void {
    // Auto-stop the worklog timer when a work block ENDS. Stops the bill
    // running on a task while the user is decompressing on break.
    if (ev.from === 'work' && activeTaskIdRef.current) {
      stopMut.mutate(activeTaskIdRef.current);
    }
    // Surface as a browser notification (best-effort — same permission gate
    // as the unread-count toast in use-notifications.ts).
    try {
      if (
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        document.visibilityState !== 'visible'
      ) {
        const body =
          ev.to === 'work'
            ? `Focus block ${ev.cycle} of 4 — back to work.`
            : ev.to === 'longBreak'
            ? 'Long break — 15 minutes off.'
            : ev.to === 'shortBreak'
            ? 'Short break — 5 minutes off.'
            : 'Session complete.';
        new Notification('Pomodoro', { body, tag: 'nockta-pomodoro' });
      }
    } catch {
      /* private mode, etc. */
    }
    // In-app surface — even when the tab is foreground, a soft toast lands.
    toast(`Pomodoro: ${phaseLabel(ev.to)}`);
  }

  const pomodoro = usePomodoro({
    enabled: pomodoroEnabled && active !== null,
    onPhaseChange: handlePhaseChange,
  });

  // Auto-start the pomodoro work block when a worklog timer is freshly
  // running AND pomodoro mode is on. The hook itself ignores duplicate
  // starts via the idle-guard, so this is safe to call eagerly.
  useEffect(() => {
    if (pomodoroEnabled && active && pomodoro.state.phase === 'idle') {
      pomodoro.controls.start();
    }
    // When the worklog stops or pomodoro flips off, reset so the chip's
    // pomodoro label doesn't linger.
    if ((!pomodoroEnabled || !active) && pomodoro.state.phase !== 'idle') {
      pomodoro.controls.reset();
    }
  }, [pomodoroEnabled, active, pomodoro.controls, pomodoro.state.phase]);

  if (!active) return null;

  const elapsedSec = Math.max(
    0,
    Math.floor((Date.now() - new Date(active.startedAt).getTime()) / 1000),
  );

  const showPomodoro = pomodoroEnabled && pomodoro.state.phase !== 'idle';

  return (
    <div
      className={cn(
        'hidden sm:inline-flex items-center gap-1.5 h-8 rounded-md border ps-2 pe-1.5',
        showPomodoro && pomodoro.state.phase !== 'work'
          ? 'border-priority-medium/40 bg-priority-medium/10'
          : 'border-status-done/40 bg-status-done/10',
      )}
      // Long titles still need a non-truncated source of truth; tooltip wins.
      title={
        showPomodoro
          ? `Pomodoro ${phaseLabel(pomodoro.state.phase)} — ${formatPomodoroTime(
              pomodoro.state.remainingSec,
            )} left. Timer running on ${active.task.key}: ${active.task.title}`
          : `Timer running on ${active.task.key}: ${active.task.title}`
      }
    >
      <span className="h-1.5 w-1.5 rounded-full bg-status-done animate-pulse shrink-0" />
      <Link
        to={`/projects/${active.task.projectId}/board?task=${active.taskId}`}
        className="text-[11px] font-mono tabular-nums text-status-done hover:underline"
      >
        {showPomodoro
          ? formatPomodoroTime(pomodoro.state.remainingSec)
          : formatHMS(elapsedSec)}
      </Link>
      {showPomodoro && (
        <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground hidden md:inline">
          {phaseLabel(pomodoro.state.phase)}
          {pomodoro.state.phase === 'work' ? ` ${pomodoro.state.cycle}/4` : ''}
        </span>
      )}
      <span
        className="text-[11px] text-muted-foreground hidden md:inline truncate max-w-[10rem]"
      >
        {active.task.key}
      </span>
      <button
        type="button"
        onClick={() => stopMut.mutate(active.taskId)}
        disabled={stopMut.isPending}
        aria-label={'Stop timer'}
        className="tap inline-flex items-center justify-center w-6 h-6 rounded-md bg-status-blocked/90 text-white hover:opacity-90 disabled:opacity-50 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Square className="h-2.5 w-2.5" aria-hidden="true" />
      </button>
    </div>
  );
}

function formatHMS(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}
