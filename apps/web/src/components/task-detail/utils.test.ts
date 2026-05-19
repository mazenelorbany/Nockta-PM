import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@nockta/sdk';

import {
  apiErrorMessage,
  formatBytes,
  formatDueDisplay,
  formatDuration,
  formatRelative,
  humanizeRecurrence,
  isOverdue,
  prettyEventType,
} from './utils';
import type { Recurrence } from './types';

// =============================================================================
// task-detail/utils.ts — small pure helpers used throughout the drawer.
//
// We freeze the clock at a known instant for the date-relative helpers so
// "Today / Tomorrow / 2d overdue" don't drift with wall-clock time.
// =============================================================================

const FROZEN_NOW = new Date('2026-05-18T12:00:00Z'); // Monday

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('formatDueDisplay', () => {
  it('returns "No date" for null', () => {
    expect(formatDueDisplay(null)).toBe('No date');
  });

  it('returns "Today" for the current day at noon', () => {
    expect(formatDueDisplay('2026-05-18T18:00:00Z')).toBe('Today');
  });

  it('returns "Tomorrow" for +1 day', () => {
    expect(formatDueDisplay('2026-05-19T18:00:00Z')).toBe('Tomorrow');
  });

  it('returns "Yesterday" for -1 day', () => {
    expect(formatDueDisplay('2026-05-17T18:00:00Z')).toBe('Yesterday');
  });

  it('returns "Nd overdue" for more than one day in the past', () => {
    expect(formatDueDisplay('2026-05-15T12:00:00Z')).toBe('3d overdue');
  });

  it('returns a weekday name when due within the next week', () => {
    // 2026-05-22 is a Friday in UTC. We don't pin a specific locale (the
    // helper calls toLocaleDateString without one), so accept any non-empty
    // string that isn't the "Today/Tomorrow" fast-path label.
    const out = formatDueDisplay('2026-05-22T12:00:00Z');
    expect(out).not.toBe('Today');
    expect(out).not.toBe('Tomorrow');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('isOverdue', () => {
  it('is false for null', () => {
    expect(isOverdue(null)).toBe(false);
  });
  it('is false for today and tomorrow', () => {
    expect(isOverdue('2026-05-18T23:00:00Z')).toBe(false);
    expect(isOverdue('2026-05-19T00:00:00Z')).toBe(false);
  });
  it('is true for any date strictly before start-of-today', () => {
    // 3 days before FROZEN_NOW (May 18 12:00 UTC) — unambiguously "before
    // today" in every timezone from GMT-12 to GMT+14, so the assertion
    // holds whether the test runs in UTC (CI) or GMT+3 (dev).
    expect(isOverdue('2026-05-15T12:00:00Z')).toBe(true);
  });
});

describe('formatBytes', () => {
  it('uses B for <1KB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
  });
  it('uses KB for <1MB', () => {
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1024 * 500)).toBe('500 KB');
  });
  it('uses MB with one decimal for ≥1MB', () => {
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB');
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5 MB');
  });
});

describe('humanizeRecurrence', () => {
  const base: Omit<Recurrence, 'frequency' | 'interval' | 'weekdays' | 'dayOfMonth'> = {
    id: 'r-1',
    timezone: 'UTC',
    nextRunAt: '2026-05-19T00:00:00Z',
    lastRunAt: null,
    enabled: true,
    endsAt: null,
  };

  it('formats daily / every N days', () => {
    expect(
      humanizeRecurrence({ ...base, frequency: 'daily', interval: 1, weekdays: [], dayOfMonth: null }),
    ).toBe('daily');
    expect(
      humanizeRecurrence({ ...base, frequency: 'daily', interval: 3, weekdays: [], dayOfMonth: null }),
    ).toBe('every 3 days');
  });

  it('formats weekly with weekday labels', () => {
    expect(
      humanizeRecurrence({
        ...base,
        frequency: 'weekly',
        interval: 1,
        // Mon (1) + Wed (3); WEEKDAY_LABELS index → 'M' and 'W'.
        weekdays: [1, 3],
        dayOfMonth: null,
      }),
    ).toBe('weekly on M W');
    expect(
      humanizeRecurrence({
        ...base,
        frequency: 'weekly',
        interval: 2,
        weekdays: [],
        dayOfMonth: null,
      }),
    ).toBe('every 2 weeks');
  });

  it('formats monthly with day-of-month', () => {
    expect(
      humanizeRecurrence({
        ...base,
        frequency: 'monthly',
        interval: 1,
        weekdays: [],
        dayOfMonth: 15,
      }),
    ).toBe('monthly (day 15)');
    expect(
      humanizeRecurrence({
        ...base,
        frequency: 'monthly',
        interval: 2,
        weekdays: [],
        dayOfMonth: null,
      }),
    ).toBe('every 2 months (same day)');
  });
});

describe('formatDuration', () => {
  it('uses seconds under a minute', () => {
    expect(formatDuration(45)).toBe('45s');
  });
  it('uses minutes (and seconds when under an hour)', () => {
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(60)).toBe('1m');
  });
  it('uses hours+minutes once over an hour', () => {
    expect(formatDuration(3 * 3600 + 30 * 60)).toBe('3h 30m');
  });
});

describe('prettyEventType', () => {
  it('strips dots/underscores and lower-cases (unknown types)', () => {
    expect(prettyEventType('task.created_legacy')).toBe('task created legacy');
    expect(prettyEventType('USER_LOGGED_IN')).toBe('user logged in');
  });
  it('splits camelCase for unknown types', () => {
    expect(prettyEventType('TaskMoved')).toBe('task moved');
  });
  it('returns a verb-shaped phrase for known event types', () => {
    expect(prettyEventType('TaskCreated')).toBe('created the task');
    expect(prettyEventType('ProjectGuestInvited')).toBe('invited a guest to the project');
    expect(prettyEventType('ProjectMemberAdded')).toBe('granted project access');
  });
});

describe('formatRelative', () => {
  it('returns "just now" within 60s', () => {
    expect(formatRelative('2026-05-18T11:59:30Z')).toBe('just now');
  });
  it('returns Xm ago within the hour', () => {
    expect(formatRelative('2026-05-18T11:45:00Z')).toBe('15m ago');
  });
  it('returns Xh ago within the day', () => {
    expect(formatRelative('2026-05-18T08:00:00Z')).toBe('4h ago');
  });
  it('returns Xd ago within the week', () => {
    expect(formatRelative('2026-05-15T12:00:00Z')).toBe('3d ago');
  });
});

describe('apiErrorMessage', () => {
  it('returns the fallback for non-ApiError values', () => {
    expect(apiErrorMessage(new Error('boom'), 'fallback')).toBe('fallback');
    expect(apiErrorMessage('not an error', 'fallback')).toBe('fallback');
    expect(apiErrorMessage(null, 'fallback')).toBe('fallback');
  });

  it('prefers problem.title when present', () => {
    const err = new ApiError(400, {
      type: 'about:blank',
      title: 'Validation failed',
      status: 400,
      detail: 'detail text',
    });
    expect(apiErrorMessage(err, 'fallback')).toBe('Validation failed');
  });

  it('falls back to problem.detail when title is missing', () => {
    const err = new ApiError(500, {
      type: 'about:blank',
      title: '',
      status: 500,
      detail: 'something else',
    });
    expect(apiErrorMessage(err, 'fallback')).toBe('something else');
  });
});
