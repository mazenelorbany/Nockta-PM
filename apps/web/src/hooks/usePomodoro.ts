import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// =============================================================================
// usePomodoro — client-side state machine for Pomodoro mode (Pass 5 R4-B).
//
// State graph:
//
//   idle ──start──▶ work(cycle 1) ──tick to 0──▶ shortBreak ──tick to 0──▶ work(cycle 2)
//                                                                            │
//                                                                            ▼
//                                                                     ... cycles 3, 4 ...
//                                                                            │
//                                                                            ▼
//                                                  work(cycle 4) ──tick to 0──▶ longBreak ──tick to 0──▶ work(cycle 1)
//
// Durations:
//   work:        25 minutes
//   shortBreak:   5 minutes  (after work cycles 1, 2, 3)
//   longBreak:   15 minutes  (after work cycle 4 — completes the "Pomodoro set")
//
// Why a separate `idle` state vs an "off" flag:
//   - `idle` lets the chip render "Start pomodoro" while the user is between
//     sessions. A plain boolean would force the caller to track "have I started
//     yet?" externally.
//   - `idle` after a longBreak ALSO acts as an automatic stop point — the
//     user is asked to explicitly start the next set rather than being roped
//     into infinite back-to-back blocks.
//
// Why Date.now() baseline, not setInterval-counted ticks:
//   Browsers throttle setInterval on background tabs (1Hz minimum, often
//   slower). Counting ticks ("decrement remainingSec each fire") would drift.
//   Instead we record phaseStartedAt and compute remaining = duration - (now -
//   phaseStartedAt) at every tick — bulletproof against tab backgrounding.
//
// Why a callback for phase change (not a fully imperative event bus):
//   Pomodoro phase changes need to surface as toasts / browser notifications
//   in two places (the chip itself + the existing notification-system hook).
//   A simple `onPhaseChange` callback is enough; callers compose their own
//   browser-notification dispatch on top of it.
// =============================================================================

export type PomodoroPhase = 'idle' | 'work' | 'shortBreak' | 'longBreak';

export interface PomodoroState {
  phase: PomodoroPhase;
  /** 1..4 — only meaningful when phase is `work`. Other phases reflect the
   *  cycle they just FINISHED, which is consistent because shortBreak only
   *  follows cycles 1..3 and longBreak only follows cycle 4. */
  cycle: number;
  /** Seconds left in the current phase. Always >= 0. */
  remainingSec: number;
  /** Total seconds for the current phase — useful for progress-bar rendering. */
  totalSec: number;
  /** ISO timestamp when the current phase started; null when idle. */
  phaseStartedAt: string | null;
}

export interface PomodoroControls {
  start(): void;
  pause(): void;
  resume(): void;
  reset(): void;
  /** Skip the current phase and advance to the next one (for testing /
   *  unstuck cases). Triggers `onPhaseChange`. */
  skip(): void;
}

export interface PomodoroEvent {
  /** What phase we just entered. */
  to: PomodoroPhase;
  /** What phase we just left. */
  from: PomodoroPhase;
  /** Which work-cycle of the set we're on, after the transition. */
  cycle: number;
}

export interface UsePomodoroOptions {
  /** Master on/off — when false, the hook returns idle and never ticks.
   *  Wire this to the user's persisted `pomodoroEnabled` preference. */
  enabled: boolean;
  /** Fires every time the phase boundary trips. */
  onPhaseChange?: (ev: PomodoroEvent) => void;
}

// Durations exported so tests can advance the fake clock by the exact phase
// length without re-stating magic numbers in two places.
export const POMODORO_DURATIONS_SEC = {
  work: 25 * 60,
  shortBreak: 5 * 60,
  longBreak: 15 * 60,
} as const;

const CYCLES_BEFORE_LONG_BREAK = 4;

/**
 * Pure transition function. Given the current state, return the state that
 * comes next when the current phase elapses. Exported separately from the
 * hook so the test suite can walk the full cycle without mounting React.
 */
export function advancePhase(state: {
  phase: PomodoroPhase;
  cycle: number;
}): { phase: PomodoroPhase; cycle: number } {
  switch (state.phase) {
    case 'idle':
      // Idle -> work(1) when start() is invoked. advancePhase isn't called
      // from idle by the tick path, but defining it here keeps the function
      // total.
      return { phase: 'work', cycle: 1 };
    case 'work':
      if (state.cycle >= CYCLES_BEFORE_LONG_BREAK) {
        return { phase: 'longBreak', cycle: state.cycle };
      }
      return { phase: 'shortBreak', cycle: state.cycle };
    case 'shortBreak':
      // After a short break we step to the next work cycle. We never short-
      // break after cycle 4 (long break path above), so the increment is
      // safe — max value here is 4.
      return { phase: 'work', cycle: state.cycle + 1 };
    case 'longBreak':
      // Long break wraps the set; reset cycle to 1.
      return { phase: 'work', cycle: 1 };
  }
}

export function phaseDurationSec(phase: PomodoroPhase): number {
  switch (phase) {
    case 'work':
      return POMODORO_DURATIONS_SEC.work;
    case 'shortBreak':
      return POMODORO_DURATIONS_SEC.shortBreak;
    case 'longBreak':
      return POMODORO_DURATIONS_SEC.longBreak;
    case 'idle':
      return 0;
  }
}

export function phaseLabel(phase: PomodoroPhase): string {
  switch (phase) {
    case 'work':
      return 'Focus';
    case 'shortBreak':
      return 'Short break';
    case 'longBreak':
      return 'Long break';
    case 'idle':
      return 'Idle';
  }
}

const IDLE_STATE: PomodoroState = {
  phase: 'idle',
  cycle: 0,
  remainingSec: 0,
  totalSec: 0,
  phaseStartedAt: null,
};

export function usePomodoro(options: UsePomodoroOptions): {
  state: PomodoroState;
  controls: PomodoroControls;
} {
  const { enabled, onPhaseChange } = options;

  // Internal state — we keep a ref + a state copy because the tick interval
  // wants to read the latest values without triggering re-runs of the effect
  // that owns it. (Owning the interval in a useEffect that depends on state
  // would re-create it on every tick, which is exactly the kind of leak we
  // want to avoid.)
  const [phase, setPhase] = useState<PomodoroPhase>('idle');
  const [cycle, setCycle] = useState<number>(0);
  const [phaseStartedAt, setPhaseStartedAt] = useState<number | null>(null);
  const [pausedRemainingSec, setPausedRemainingSec] = useState<number | null>(
    null,
  );
  // 1Hz tick driver — purely for triggering re-renders so the remainingSec
  // computation pulls a fresh `Date.now()`. We DON'T store time-left in
  // state; we derive it on each render.
  const [, force] = useState(0);

  const onPhaseChangeRef = useRef(onPhaseChange);
  useEffect(() => {
    onPhaseChangeRef.current = onPhaseChange;
  }, [onPhaseChange]);

  // When `enabled` flips off, fully reset back to idle. The user shouldn't
  // come back later and find a stale half-finished phase.
  useEffect(() => {
    if (!enabled) {
      setPhase('idle');
      setCycle(0);
      setPhaseStartedAt(null);
      setPausedRemainingSec(null);
    }
  }, [enabled]);

  // ---------- Derived state ----------
  const totalSec = phaseDurationSec(phase);
  let remainingSec = 0;
  if (phase === 'idle') {
    remainingSec = 0;
  } else if (pausedRemainingSec !== null) {
    remainingSec = pausedRemainingSec;
  } else if (phaseStartedAt !== null) {
    const elapsed = Math.floor((Date.now() - phaseStartedAt) / 1000);
    remainingSec = Math.max(0, totalSec - elapsed);
  }

  // ---------- Tick + auto-transition ----------
  //
  // The tick effect re-installs only when the phase boundaries change
  // (phase, phaseStartedAt, paused). On each tick we (a) force a re-render so
  // the derived remainingSec updates and (b) check whether the phase has
  // elapsed and we need to transition.
  useEffect(() => {
    if (!enabled) return;
    if (phase === 'idle') return;
    if (pausedRemainingSec !== null) return;
    if (phaseStartedAt === null) return;

    const id = window.setInterval(() => {
      force((n) => n + 1);
      const elapsed = Math.floor((Date.now() - phaseStartedAt) / 1000);
      if (elapsed >= totalSec) {
        // Phase boundary tripped. Run the pure transition + record the start
        // instant of the new phase. We compute the new phase from the
        // current ref-like values to avoid stale-closure issues if the
        // user happened to call `skip` in the same tick.
        const next = advancePhase({ phase, cycle });
        const nowMs = Date.now();
        setPhase(next.phase);
        setCycle(next.cycle);
        setPhaseStartedAt(nowMs);
        // Fire the callback OUT-OF-RENDER via setTimeout(0). Calling it
        // synchronously here would be inside React's commit phase if a
        // sibling component is currently rendering; queuing it onto the
        // macrotask loop avoids the warning.
        const ev: PomodoroEvent = { from: phase, to: next.phase, cycle: next.cycle };
        window.setTimeout(() => onPhaseChangeRef.current?.(ev), 0);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [enabled, phase, cycle, phaseStartedAt, pausedRemainingSec, totalSec]);

  // ---------- Controls ----------
  const start = useCallback((): void => {
    if (!enabled) return;
    if (phase !== 'idle') return;
    const nowMs = Date.now();
    setPhase('work');
    setCycle(1);
    setPhaseStartedAt(nowMs);
    setPausedRemainingSec(null);
    window.setTimeout(
      () => onPhaseChangeRef.current?.({ from: 'idle', to: 'work', cycle: 1 }),
      0,
    );
  }, [enabled, phase]);

  const pause = useCallback((): void => {
    if (phase === 'idle') return;
    if (pausedRemainingSec !== null) return;
    if (phaseStartedAt === null) return;
    const elapsed = Math.floor((Date.now() - phaseStartedAt) / 1000);
    setPausedRemainingSec(Math.max(0, totalSec - elapsed));
  }, [phase, pausedRemainingSec, phaseStartedAt, totalSec]);

  const resume = useCallback((): void => {
    if (pausedRemainingSec === null) return;
    // Recompute phaseStartedAt so the next tick computes the same remaining
    // we paused at: pausedRemaining = total - (now - newStart) ⇒
    // newStart = now - (total - pausedRemaining).
    const nowMs = Date.now();
    setPhaseStartedAt(nowMs - (totalSec - pausedRemainingSec) * 1000);
    setPausedRemainingSec(null);
  }, [pausedRemainingSec, totalSec]);

  const reset = useCallback((): void => {
    setPhase('idle');
    setCycle(0);
    setPhaseStartedAt(null);
    setPausedRemainingSec(null);
  }, []);

  const skip = useCallback((): void => {
    if (phase === 'idle') return;
    const next = advancePhase({ phase, cycle });
    const nowMs = Date.now();
    setPhase(next.phase);
    setCycle(next.cycle);
    setPhaseStartedAt(nowMs);
    setPausedRemainingSec(null);
    window.setTimeout(
      () => onPhaseChangeRef.current?.({ from: phase, to: next.phase, cycle: next.cycle }),
      0,
    );
  }, [phase, cycle]);

  const state: PomodoroState = useMemo(
    () => ({
      phase,
      cycle,
      remainingSec,
      totalSec,
      phaseStartedAt: phaseStartedAt === null ? null : new Date(phaseStartedAt).toISOString(),
    }),
    [phase, cycle, remainingSec, totalSec, phaseStartedAt],
  );

  return {
    state,
    controls: { start, pause, resume, reset, skip },
  };
}

/**
 * Helper for formatting a Pomodoro remaining-seconds value into `MM:SS`. Lives
 * here next to the hook so the chip and any future surface (a fullscreen
 * focus view, a notification body) all format the same way.
 */
export function formatPomodoroTime(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
