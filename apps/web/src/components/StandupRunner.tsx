import { useQuery } from '@tanstack/react-query';
import {
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@nockta/ui';

import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

import { AvatarCircle } from './task-bits';

// =============================================================================
// StandupRunner — Linear-style team standup driver.
//
// Drops in as a left column on the project board. Builds a participant list
// from the tasks visible on the board (so it always tracks the real assignees
// in this sprint), gives each person a 2-minute timer, and walks the team
// through one at a time. Optional team-scope filter narrows the list to
// Engineering / Design / etc. via the existing Team model.
//
// Pure presentation + local state — no backend writes. The "current speaker"
// can also be used by the parent to filter the board to that person's tasks,
// but that's the parent's call (we just expose it via onSpeakerChange).
// =============================================================================

export interface StandupParticipant {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string | null;
  taskCount: number;
}

export interface TaskWithAssignee {
  assignee?: { id: string; name: string; avatarUrl?: string | null } | null | undefined;
}

interface Team {
  id: string;
  name: string;
  slug: string;
}

interface TeamWithMembers extends Team {
  members: Array<{ userId: string }>;
}

const SECONDS_PER_TURN = 120; // 2-minute timer per person, like the screenshot.
const DEFAULT_SCOPE = '__all__';
const UNASSIGNED_ID = '__unassigned__';

export function StandupRunner({
  tasks,
  onClose,
  onSpeakerChange,
}: {
  /** All tasks on the current board. Used to derive the participant list. */
  tasks: TaskWithAssignee[];
  onClose: () => void;
  /** Fired whenever the active speaker changes. Pass null when standup ends.
   *  Parent can use it to filter the board to that person's tasks. */
  onSpeakerChange?: (userId: string | null) => void;
}): JSX.Element {
  // ---- Scope selection (team filter) -----------------------------------
  // Teams come from the workspace-level /teams endpoint. Cheap query, cached
  // long enough that bouncing through the standup doesn't refetch it.
  const teamsQuery = useQuery({
    queryKey: queryKeys.teams(),
    queryFn: () => api.get<Team[]>('/teams'),
    staleTime: 5 * 60_000,
  });
  const teams = teamsQuery.data ?? [];
  const [scope, setScope] = useState<string>(DEFAULT_SCOPE);

  // When a team scope is chosen, fetch the team WITH its members so we can
  // intersect with the board's assignees. /teams/:id returns the team and
  // its TeamMember rows in a single shot — no separate members endpoint.
  const teamQuery = useQuery({
    queryKey: ['team', scope],
    queryFn: () => api.get<TeamWithMembers>(`/teams/${scope}`),
    enabled: scope !== DEFAULT_SCOPE,
    staleTime: 60_000,
  });
  const teamMemberIds = useMemo(
    () => new Set((teamQuery.data?.members ?? []).map((m) => m.userId)),
    [teamQuery.data],
  );

  // ---- Participant derivation ------------------------------------------
  // Walk the loaded tasks once: dedup assignees, count tasks per person,
  // append an "Unassigned" pseudo-participant if there's unowned work. Sort
  // by task count desc so the busiest person goes first by default.
  const participants = useMemo<StandupParticipant[]>(() => {
    const byId = new Map<string, StandupParticipant>();
    let unassignedCount = 0;
    for (const t of tasks) {
      const a = t.assignee;
      if (!a) {
        unassignedCount += 1;
        continue;
      }
      if (scope !== DEFAULT_SCOPE && !teamMemberIds.has(a.id)) continue;
      const existing = byId.get(a.id);
      if (existing) {
        existing.taskCount += 1;
      } else {
        byId.set(a.id, {
          id: a.id,
          name: a.name,
          avatarUrl: a.avatarUrl ?? null,
          taskCount: 1,
        });
      }
    }
    const list = Array.from(byId.values()).sort((a, b) => {
      if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount;
      return a.name.localeCompare(b.name);
    });
    // Unassigned only shown for the "all" scope; team standups don't care
    // about unowned tickets.
    if (scope === DEFAULT_SCOPE && unassignedCount > 0) {
      list.push({
        id: UNASSIGNED_ID,
        name: 'Unassigned',
        taskCount: unassignedCount,
      });
    }
    return list;
  }, [tasks, scope, teamMemberIds]);

  // ---- Turn + timer state ---------------------------------------------
  const [turnIndex, setTurnIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(SECONDS_PER_TURN);
  const [running, setRunning] = useState(false);
  const [soundOn, setSoundOn] = useState(true);

  // Clamp the turn index if the participant list shrinks (e.g. scope change).
  useEffect(() => {
    if (turnIndex >= participants.length && participants.length > 0) {
      setTurnIndex(0);
      setSecondsLeft(SECONDS_PER_TURN);
    }
  }, [participants.length, turnIndex]);

  // Fire onSpeakerChange whenever the active person changes.
  const currentParticipant = participants[turnIndex] ?? null;
  useEffect(() => {
    if (!onSpeakerChange) return;
    onSpeakerChange(currentParticipant?.id ?? null);
  }, [currentParticipant, onSpeakerChange]);

  // Tell the parent we're done when the runner unmounts.
  useEffect(() => {
    return () => {
      onSpeakerChange?.(null);
    };
  }, [onSpeakerChange]);

  // ---- Timer tick + chime ---------------------------------------------
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playChime = useCallback(() => {
    if (!soundOn) return;
    try {
      // Lazy-init a single AudioContext. Browsers throw if you create too
      // many; reuse is required.
      if (!audioCtxRef.current) {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new Ctor();
      }
      const ctx = audioCtxRef.current;
      // Two-tone "ding" — short and unobtrusive but noticeable.
      const tones = [880, 660];
      const now = ctx.currentTime;
      tones.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.18);
        gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.18 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + i * 0.18);
        osc.stop(now + i * 0.18 + 0.3);
      });
    } catch {
      /* sound is optional, never throw */
    }
  }, [soundOn]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          playChime();
          // Auto-advance to next person and pause; the moderator confirms.
          setTurnIndex((i) => Math.min(i + 1, participants.length - 1));
          setRunning(false);
          return SECONDS_PER_TURN;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [running, participants.length, playChime]);

  // ---- Controls --------------------------------------------------------
  function toggleRun(): void {
    setRunning((r) => !r);
  }
  function resetTimer(): void {
    setSecondsLeft(SECONDS_PER_TURN);
  }
  function gotoIndex(i: number): void {
    if (i < 0 || i >= participants.length) return;
    setTurnIndex(i);
    setSecondsLeft(SECONDS_PER_TURN);
  }
  function next(): void {
    gotoIndex(Math.min(turnIndex + 1, participants.length - 1));
  }
  function prev(): void {
    gotoIndex(Math.max(turnIndex - 1, 0));
  }

  // ESC closes the runner so the moderator can bail without grabbing the mouse.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === ' ' && (e.target as HTMLElement | null)?.tagName !== 'INPUT') {
        e.preventDefault();
        toggleRun();
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        next();
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        prev();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants.length, turnIndex]);

  // ---- Render ----------------------------------------------------------
  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const progressPct = ((SECONDS_PER_TURN - secondsLeft) / SECONDS_PER_TURN) * 100;

  return (
    <aside className="w-[260px] shrink-0 border-e border-border bg-card/40 flex flex-col">
      {/* Header */}
      <header className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <p className="nockta-eyebrow text-brand">{'Standup'}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {`${participants.length} people · 2 min each`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="tap inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          aria-label={'End standup'}
          title={'End standup (Esc)'}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* Scope picker */}
      <div className="px-4 py-3 border-b border-border space-y-2">
        <p className="nockta-eyebrow text-muted-foreground/70 text-[0.65rem]">
          {'Scope'}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <ScopeChip
            label={'All'}
            active={scope === DEFAULT_SCOPE}
            onClick={() => setScope(DEFAULT_SCOPE)}
          />
          {teams.map((team) => (
            <ScopeChip
              key={team.id}
              label={team.name}
              active={scope === team.id}
              onClick={() => setScope(team.id)}
            />
          ))}
        </div>
      </div>

      {/* Timer */}
      <div className="px-4 py-4 border-b border-border">
        <div className="relative">
          <div className="text-5xl font-mono tabular-nums tracking-tight text-foreground text-center">
            {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
          </div>
          {/* Progress bar — empties as the timer runs down. */}
          <div className="mt-3 h-1 w-full rounded-full bg-secondary overflow-hidden">
            <div
              className={cn(
                'h-full transition-[width] duration-1000 ease-linear',
                secondsLeft <= 15 ? 'bg-status-blocked' : 'bg-brand',
              )}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
        <div className="mt-3 flex items-center justify-center gap-1">
          <IconButton onClick={prev} disabled={turnIndex === 0} label="Previous (k)">
            <SkipBack className="h-3.5 w-3.5" />
          </IconButton>
          <button
            type="button"
            onClick={toggleRun}
            disabled={participants.length === 0}
            className="tap inline-flex items-center justify-center h-9 w-9 rounded-full bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-40"
            aria-label={running ? 'Pause (Space)' : 'Play (Space)'}
            title={running ? 'Pause (Space)' : 'Play (Space)'}
          >
            {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
          </button>
          <IconButton onClick={next} disabled={turnIndex >= participants.length - 1} label="Next (j)">
            <SkipForward className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton onClick={resetTimer} label="Reset turn">
            <RotateCcw className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton onClick={() => setSoundOn((s) => !s)} label={soundOn ? 'Sound on' : 'Sound off'}>
            {soundOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5 opacity-60" />}
          </IconButton>
        </div>
      </div>

      {/* Participants */}
      <div className="flex-1 overflow-y-auto py-2">
        {participants.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            {scope === DEFAULT_SCOPE
              ? 'No one has tasks on this board yet.'
              : 'No one from this team is assigned here.'}
          </p>
        ) : (
          <ul className="space-y-0.5 px-2">
            {participants.map((p, i) => {
              const isCurrent = i === turnIndex;
              const isDone = i < turnIndex;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => gotoIndex(i)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left transition-colors',
                      isCurrent
                        ? 'bg-brand/15 text-foreground ring-1 ring-brand/30'
                        : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                      isDone && !isCurrent && 'opacity-60',
                    )}
                  >
                    {p.id === UNASSIGNED_ID ? (
                      <AvatarCircle user={null} size={22} />
                    ) : (
                      <AvatarCircle user={p} size={22} />
                    )}
                    <span className="flex-1 truncate">{p.name}</span>
                    <span className="text-[10px] font-mono text-muted-foreground">{p.taskCount}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Footer hint */}
      <footer className="px-4 py-2.5 border-t border-border text-[10px] text-muted-foreground/70 leading-relaxed">
        <span className="font-mono">Space</span> play/pause ·{' '}
        <span className="font-mono">j/k</span> next/prev ·{' '}
        <span className="font-mono">Esc</span> end
      </footer>
    </aside>
  );
}

function ScopeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
        active
          ? 'bg-brand text-brand-foreground'
          : 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}

function IconButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="tap inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
