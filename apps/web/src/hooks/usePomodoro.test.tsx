import { describe, expect, it } from 'vitest';

import {
  POMODORO_DURATIONS_SEC,
  advancePhase,
  formatPomodoroTime,
  phaseDurationSec,
  phaseLabel,
  type PomodoroPhase,
} from './usePomodoro';

// =============================================================================
// usePomodoro — pure-function tests.
//
// vitest.config.ts in apps/web is Node-only (no jsdom), so we can't render
// the hook directly. Instead we cover the pure pieces that the React surface
// composes onto a timer:
//
//   - advancePhase: state-machine transitions (the entire 4-cycle set).
//   - phaseDurationSec / phaseLabel: small lookup helpers.
//   - formatPomodoroTime: the MM:SS formatter (off-by-one bugs here would
//     ship a flickering chip in production).
//
// The integration of these with React's lifecycle is exercised in the chip
// when a future jsdom-enabled test config lands.
// =============================================================================

describe('advancePhase — full 4-cycle Pomodoro set', () => {
  // Walks the state machine through one complete set:
  //   work 1 → shortBreak → work 2 → shortBreak → work 3 → shortBreak
  //   → work 4 → longBreak → work 1 (new set).
  // Each step asserts the (phase, cycle) tuple so a future change to the
  // transition table (e.g. swapping to 3-cycle sets) lights this up loudly.

  it('starts at idle and steps to work cycle 1 when "started"', () => {
    expect(advancePhase({ phase: 'idle', cycle: 0 })).toEqual({
      phase: 'work',
      cycle: 1,
    });
  });

  it('after work cycle 1 → shortBreak (still cycle 1)', () => {
    expect(advancePhase({ phase: 'work', cycle: 1 })).toEqual({
      phase: 'shortBreak',
      cycle: 1,
    });
  });

  it('after shortBreak following cycle 1 → work cycle 2', () => {
    expect(advancePhase({ phase: 'shortBreak', cycle: 1 })).toEqual({
      phase: 'work',
      cycle: 2,
    });
  });

  it('after work cycles 2 and 3 → shortBreak', () => {
    expect(advancePhase({ phase: 'work', cycle: 2 })).toEqual({
      phase: 'shortBreak',
      cycle: 2,
    });
    expect(advancePhase({ phase: 'work', cycle: 3 })).toEqual({
      phase: 'shortBreak',
      cycle: 3,
    });
  });

  it('after work cycle 4 → longBreak (not shortBreak)', () => {
    expect(advancePhase({ phase: 'work', cycle: 4 })).toEqual({
      phase: 'longBreak',
      cycle: 4,
    });
  });

  it('after longBreak → wraps to work cycle 1 (a fresh set)', () => {
    expect(advancePhase({ phase: 'longBreak', cycle: 4 })).toEqual({
      phase: 'work',
      cycle: 1,
    });
  });

  it('walks an end-to-end set deterministically', () => {
    let state: { phase: PomodoroPhase; cycle: number } = { phase: 'work', cycle: 1 };
    const journey: Array<{ phase: PomodoroPhase; cycle: number }> = [state];
    // 1 set = 4 work + 3 shortBreak + 1 longBreak = 8 transitions
    // (we count work cycle 1 as the start state above, then take 8 hops to
    // land back on the start of the next set).
    for (let i = 0; i < 8; i += 1) {
      state = advancePhase(state);
      journey.push({ ...state });
    }
    expect(journey).toEqual([
      { phase: 'work', cycle: 1 },
      { phase: 'shortBreak', cycle: 1 },
      { phase: 'work', cycle: 2 },
      { phase: 'shortBreak', cycle: 2 },
      { phase: 'work', cycle: 3 },
      { phase: 'shortBreak', cycle: 3 },
      { phase: 'work', cycle: 4 },
      { phase: 'longBreak', cycle: 4 },
      { phase: 'work', cycle: 1 },
    ]);
  });
});

describe('phaseDurationSec', () => {
  it('returns the canonical durations', () => {
    expect(phaseDurationSec('work')).toBe(25 * 60);
    expect(phaseDurationSec('shortBreak')).toBe(5 * 60);
    expect(phaseDurationSec('longBreak')).toBe(15 * 60);
    expect(phaseDurationSec('idle')).toBe(0);
  });

  it('matches POMODORO_DURATIONS_SEC', () => {
    expect(phaseDurationSec('work')).toBe(POMODORO_DURATIONS_SEC.work);
    expect(phaseDurationSec('shortBreak')).toBe(POMODORO_DURATIONS_SEC.shortBreak);
    expect(phaseDurationSec('longBreak')).toBe(POMODORO_DURATIONS_SEC.longBreak);
  });
});

describe('phaseLabel', () => {
  it('returns human-readable strings for every phase', () => {
    expect(phaseLabel('idle')).toBe('Idle');
    expect(phaseLabel('work')).toBe('Focus');
    expect(phaseLabel('shortBreak')).toBe('Short break');
    expect(phaseLabel('longBreak')).toBe('Long break');
  });
});

describe('formatPomodoroTime', () => {
  it('pads minute and second components to two digits', () => {
    expect(formatPomodoroTime(0)).toBe('00:00');
    expect(formatPomodoroTime(5)).toBe('00:05');
    expect(formatPomodoroTime(65)).toBe('01:05');
    expect(formatPomodoroTime(25 * 60)).toBe('25:00');
  });

  it('clamps negative input to 00:00 (defensive)', () => {
    expect(formatPomodoroTime(-1)).toBe('00:00');
    expect(formatPomodoroTime(-1000)).toBe('00:00');
  });

  it('floors fractional seconds (no 1.5s flicker)', () => {
    expect(formatPomodoroTime(59.9)).toBe('00:59');
    expect(formatPomodoroTime(60.4)).toBe('01:00');
  });
});
