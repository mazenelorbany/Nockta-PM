import { describe, expect, it } from 'vitest';

import { applyTaskFilters } from './applyTaskFilters';
import { EMPTY_FILTERS, type TaskFilters } from './types';

// =============================================================================
// applyTaskFilters — the single narrowing function used by every board, list,
// and dashboard view. A miss here multiplies across surfaces, so we cover
// each filter axis and the "all empty" identity case.
// =============================================================================

type T = Parameters<typeof applyTaskFilters>[0][number];

function makeTask(over: Partial<T>): T {
  return {
    id: 'id',
    key: 'PROJ-1',
    title: 'Untitled',
    status: 'Todo',
    priority: 'Medium',
    isBlocked: false,
    ...over,
  };
}

function filters(over: Partial<TaskFilters> = {}): TaskFilters {
  return { ...EMPTY_FILTERS, ...over };
}

describe('applyTaskFilters — identity', () => {
  it('returns the same list (object-equal entries) when no filters set', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
    expect(applyTaskFilters(tasks, filters())).toEqual(tasks);
  });
});

describe('applyTaskFilters — single-axis narrowing', () => {
  const tasks: T[] = [
    makeTask({ id: 'a', priority: 'High', type: 'Bug', isBlocked: true, assignee: { id: 'u1', name: 'Alex' } }),
    makeTask({ id: 'b', priority: 'Low', type: 'Story', status: 'Done', assignee: { id: 'u2', name: 'Sam' } }),
    makeTask({ id: 'c', priority: 'High', type: 'Task' }),
  ];

  it('priority', () => {
    expect(applyTaskFilters(tasks, filters({ priority: 'High' })).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('type', () => {
    expect(applyTaskFilters(tasks, filters({ type: 'Bug' })).map((t) => t.id)).toEqual(['a']);
    // Task type defaults: a row missing `type` is treated as Task.
    expect(applyTaskFilters(tasks, filters({ type: 'Task' })).map((t) => t.id)).toEqual(['c']);
  });

  it('blocked-only', () => {
    expect(applyTaskFilters(tasks, filters({ blocked: true })).map((t) => t.id)).toEqual(['a']);
  });

  it('hideDone strips the "Done" status (case-insensitive)', () => {
    expect(applyTaskFilters(tasks, filters({ hideDone: true })).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('search matches key + title, case-insensitive', () => {
    const t = [
      makeTask({ id: 'a', key: 'PROJ-10', title: 'Auth flow' }),
      makeTask({ id: 'b', key: 'PROJ-11', title: 'Dashboard polish' }),
    ];
    expect(applyTaskFilters(t, filters({ search: 'AUTH' })).map((x) => x.id)).toEqual(['a']);
    expect(applyTaskFilters(t, filters({ search: 'proj-11' })).map((x) => x.id)).toEqual(['b']);
  });

  it('assignee: unassigned special case', () => {
    expect(applyTaskFilters(tasks, filters({ assigneeUserId: 'unassigned' })).map((t) => t.id)).toEqual(['c']);
  });

  it('assignee: specific user id', () => {
    expect(applyTaskFilters(tasks, filters({ assigneeUserId: 'u2' })).map((t) => t.id)).toEqual(['b']);
  });
});

describe('applyTaskFilters — sprint, projects, labels (OR semantics)', () => {
  it('sprintId: backlog matches only tasks with no sprint', () => {
    const t = [
      makeTask({ id: 'a', sprintId: null }),
      makeTask({ id: 'b', sprintId: 's1' }),
      makeTask({ id: 'c' }), // missing sprintId → null
    ];
    expect(applyTaskFilters(t, filters({ sprintId: 'backlog' })).map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('sprintId: specific sprint', () => {
    const t = [
      makeTask({ id: 'a', sprintId: 's1' }),
      makeTask({ id: 'b', sprintId: 's2' }),
    ];
    expect(applyTaskFilters(t, filters({ sprintId: 's1' })).map((x) => x.id)).toEqual(['a']);
  });

  it('projectIds: narrows only when set, ignores when empty', () => {
    const t = [
      makeTask({ id: 'a', projectId: 'p1' }),
      makeTask({ id: 'b', projectId: 'p2' }),
    ];
    expect(applyTaskFilters(t, filters({ projectIds: ['p2'] })).map((x) => x.id)).toEqual(['b']);
    // Empty array → no-op.
    expect(applyTaskFilters(t, filters({ projectIds: [] })).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('labelIds: OR semantics — a task with ANY of the picked labels matches', () => {
    const t = [
      makeTask({ id: 'a', labels: [{ label: { id: 'l1' } }, { label: { id: 'l2' } }] }),
      makeTask({ id: 'b', labels: [{ label: { id: 'l3' } }] }),
      makeTask({ id: 'c' }), // no labels → excluded when filter set
    ];
    expect(applyTaskFilters(t, filters({ labelIds: ['l1'] })).map((x) => x.id)).toEqual(['a']);
    expect(applyTaskFilters(t, filters({ labelIds: ['l2', 'l3'] })).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('custom fields: AND across keys, list-value uses includes()', () => {
    const t = [
      makeTask({ id: 'a', customFieldValues: [{ fieldId: 'f1', value: 'red' }, { fieldId: 'f2', value: ['x', 'y'] }] }),
      makeTask({ id: 'b', customFieldValues: [{ fieldId: 'f1', value: 'red' }] }),
      makeTask({ id: 'c', customFieldValues: [{ fieldId: 'f1', value: 'blue' }] }),
    ];
    expect(
      applyTaskFilters(t, filters({ customFields: { f1: 'red' } })).map((x) => x.id),
    ).toEqual(['a', 'b']);
    expect(
      applyTaskFilters(t, filters({ customFields: { f1: 'red', f2: 'y' } })).map((x) => x.id),
    ).toEqual(['a']);
  });
});
