import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@nockta/sdk';

import { applyFilters, apiErrorMessage, toggleSelected } from './helpers';
import type { PlannerTask } from './types';

// =============================================================================
// project-backlog helpers — pure narrowing + small set toggler. Backlog page
// is one of the highest-traffic surfaces in the app (PMs grooming weekly),
// so the filter narrowing logic is worth pinning down.
// =============================================================================

function task(overrides: Partial<PlannerTask>): PlannerTask {
  return {
    id: 'id',
    key: 'PROJ-1',
    type: 'Task',
    title: 'Untitled',
    status: 'Todo',
    priority: 'Medium',
    estimate: null,
    dueDate: null,
    isBlocked: false,
    assignee: null,
    labels: [],
    ...overrides,
  };
}

describe('applyFilters', () => {
  const tasks: PlannerTask[] = [
    task({ id: 't1', key: 'PROJ-1', title: 'Set up auth', assignee: { id: 'u1', name: 'Alex' }, priority: 'High' }),
    task({ id: 't2', key: 'PROJ-2', title: 'Wire login UI', assignee: { id: 'u2', name: 'Sam' }, priority: 'Low' }),
    task({ id: 't3', key: 'PROJ-3', title: 'Polish dashboard', assignee: null, priority: 'High' }),
  ];

  it('returns everything when all filters are empty', () => {
    expect(applyFilters(tasks, '', '', '').map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('narrows by case-insensitive substring on key + title', () => {
    expect(applyFilters(tasks, 'login', '', '').map((t) => t.id)).toEqual(['t2']);
    expect(applyFilters(tasks, 'PROJ-1', '', '').map((t) => t.id)).toEqual(['t1']);
    expect(applyFilters(tasks, 'DASH', '', '').map((t) => t.id)).toEqual(['t3']);
  });

  it('narrows by assignee id (and excludes unassigned when an id is set)', () => {
    expect(applyFilters(tasks, '', 'u1', '').map((t) => t.id)).toEqual(['t1']);
    expect(applyFilters(tasks, '', 'u2', '').map((t) => t.id)).toEqual(['t2']);
  });

  it('narrows by priority', () => {
    expect(applyFilters(tasks, '', '', 'High').map((t) => t.id)).toEqual(['t1', 't3']);
    expect(applyFilters(tasks, '', '', 'Low').map((t) => t.id)).toEqual(['t2']);
  });

  it('AND-combines multiple active filters', () => {
    expect(applyFilters(tasks, 'login', 'u2', 'Low').map((t) => t.id)).toEqual(['t2']);
    expect(applyFilters(tasks, 'login', 'u1', '').map((t) => t.id)).toEqual([]);
  });

  it('trims whitespace from the search query', () => {
    expect(applyFilters(tasks, '   login   ', '', '').map((t) => t.id)).toEqual(['t2']);
  });
});

describe('toggleSelected', () => {
  it('adds an id when not present and removes it when present', () => {
    let state = new Set<string>();
    // toggleSelected calls the setter functionally; capture the result.
    const setSel = vi.fn((updater: (prev: Set<string>) => Set<string>) => {
      state = updater(state);
    }) as unknown as React.Dispatch<React.SetStateAction<Set<string>>>;

    toggleSelected(setSel, 'a');
    expect([...state]).toEqual(['a']);

    toggleSelected(setSel, 'b');
    expect([...state].sort()).toEqual(['a', 'b']);

    toggleSelected(setSel, 'a');
    expect([...state]).toEqual(['b']);
  });

  it('does not mutate the previous Set instance (returns a new one)', () => {
    let captured: Set<string> | null = null;
    const initial = new Set(['x']);
    const setSel = ((updater: (prev: Set<string>) => Set<string>) => {
      captured = updater(initial);
    }) as unknown as React.Dispatch<React.SetStateAction<Set<string>>>;
    toggleSelected(setSel, 'y');
    expect(captured).not.toBe(initial);
    expect([...initial]).toEqual(['x']);
  });
});

describe('apiErrorMessage', () => {
  it('returns the fallback for non-ApiError values', () => {
    expect(apiErrorMessage(new Error('boom'), 'fb')).toBe('fb');
    expect(apiErrorMessage(undefined, 'fb')).toBe('fb');
  });

  it('prefers problem.detail over title (matches the backlog UI which surfaces the longer one)', () => {
    const err = new ApiError(422, {
      type: 'about:blank',
      title: 'Validation failed',
      detail: 'sprint goal too long',
      status: 422,
    });
    expect(apiErrorMessage(err, 'fb')).toBe('sprint goal too long');
  });

  it('falls back to problem.title when detail is absent', () => {
    const err = new ApiError(409, {
      type: 'about:blank',
      title: 'Sprint locked',
      status: 409,
    });
    expect(apiErrorMessage(err, 'fb')).toBe('Sprint locked');
  });

  it('returns the fallback when neither detail nor title is set', () => {
    const err = new ApiError(500, { type: 'about:blank', title: '', status: 500 });
    expect(apiErrorMessage(err, 'fb')).toBe('fb');
  });
});
