import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@nockta/sdk';
import type { DragEndEvent } from '@dnd-kit/core';

import type { Task } from '../types';

// =============================================================================
// useDragReorder — the board drop handler.
//
// The hook is just `useCallback(fn, deps)`. We mock React's useCallback to a
// pass-through so the test can drive the callback directly under Node (no
// jsdom required). The api client and react-hot-toast are mocked too so we
// observe what HTTP calls would have happened.
//
// Bug-classes pinned:
//   - Same-column reorder calls /reorder once with the right neighbours.
//   - Cross-column drop first PATCHes /status, then /reorder.
//   - Drop on column body (col:<status>) appends and skips /reorder.
//   - Optimistic cache update reflects the new status + sorted order.
//   - API failure rolls the cache back to the prior state.
// =============================================================================

vi.mock('react', () => ({
  useCallback: <T,>(fn: T): T => fn,
}));

vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const apiPatch = vi.fn();
vi.mock('../../../lib/api', () => ({
  api: {
    patch: (...args: unknown[]) => apiPatch(...args),
  },
}));

// Import AFTER mocks so the hook closes over them.
import { useDragReorder } from './useDragReorder';

function makeTask(over: Partial<Task>): Task {
  return {
    id: 'id',
    key: 'PROJ-1',
    title: 'Untitled',
    status: 'Todo',
    priority: 'Medium',
    isBlocked: false,
    boardPosition: 'a0',
    ...over,
  };
}

function event(activeId: string, overId: string): DragEndEvent {
  return {
    active: { id: activeId } as DragEndEvent['active'],
    over: { id: overId } as DragEndEvent['over'],
    collisions: null,
    delta: { x: 0, y: 0 },
  } as DragEndEvent;
}

beforeEach(() => {
  apiPatch.mockReset();
  apiPatch.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
});

function newQueryClient(tasks: Task[], projectId: string): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(['tasks', 'project', projectId], tasks);
  return qc;
}

describe('useDragReorder — early exits', () => {
  it('is a no-op when there is no drop target', async () => {
    const tasks = [makeTask({ id: 't1', boardPosition: 'a0' })];
    const qc = newQueryClient(tasks, 'proj');
    const onDragEnd = useDragReorder({ tasks, projectId: 'proj', queryClient: qc });
    await onDragEnd({
      active: { id: 't1' } as DragEndEvent['active'],
      over: null,
    } as DragEndEvent);
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('is a no-op when active === over', async () => {
    const tasks = [makeTask({ id: 't1' })];
    const qc = newQueryClient(tasks, 'proj');
    const onDragEnd = useDragReorder({ tasks, projectId: 'proj', queryClient: qc });
    await onDragEnd(event('t1', 't1'));
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('is a no-op when the active task id is unknown', async () => {
    const tasks = [makeTask({ id: 't1' })];
    const qc = newQueryClient(tasks, 'proj');
    const onDragEnd = useDragReorder({ tasks, projectId: 'proj', queryClient: qc });
    await onDragEnd(event('does-not-exist', 't1'));
    expect(apiPatch).not.toHaveBeenCalled();
  });
});

describe('useDragReorder — same-column reorder', () => {
  it('PATCHes /reorder with the before/after neighbour positions', async () => {
    const tasks: Task[] = [
      makeTask({ id: 't1', status: 'Todo', boardPosition: 'a0' }),
      makeTask({ id: 't2', status: 'Todo', boardPosition: 'a1' }),
      makeTask({ id: 't3', status: 'Todo', boardPosition: 'a2' }),
    ];
    const qc = newQueryClient(tasks, 'proj');
    const onDragEnd = useDragReorder({ tasks, projectId: 'proj', queryClient: qc });

    // Drop t3 onto t1 → insert ABOVE t1 in column Todo.
    // destList (without t3) sorted: [t1@a0, t2@a1]. targetIdx = 0.
    //   beforeId = destList[-1] = null
    //   afterId  = destList[0]  = t1
    // → reorder body: { after: 'a0' }
    await onDragEnd(event('t3', 't1'));
    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch).toHaveBeenCalledWith('/tasks/t3/reorder', { after: 'a0' });
  });

  it('drop on a middle target produces both before and after keys', async () => {
    const tasks: Task[] = [
      makeTask({ id: 't1', status: 'Todo', boardPosition: 'a0' }),
      makeTask({ id: 't2', status: 'Todo', boardPosition: 'a1' }),
      makeTask({ id: 't3', status: 'Todo', boardPosition: 'a2' }),
    ];
    const qc = newQueryClient(tasks, 'proj');
    const onDragEnd = useDragReorder({ tasks, projectId: 'proj', queryClient: qc });
    // Drop t1 onto t3 → destList without t1 = [t2@a1, t3@a2], target = t3 at idx 1.
    //   beforeId = t2 → before: 'a1'
    //   afterId  = t3 → after:  'a2'
    await onDragEnd(event('t1', 't3'));
    expect(apiPatch).toHaveBeenCalledWith('/tasks/t1/reorder', { before: 'a1', after: 'a2' });
  });
});

describe('useDragReorder — cross-column drop on a card', () => {
  it('PATCHes /status then /reorder', async () => {
    const tasks: Task[] = [
      makeTask({ id: 't1', status: 'Todo', boardPosition: 'a0' }),
      makeTask({ id: 't2', status: 'In Progress', boardPosition: 'b0' }),
      makeTask({ id: 't3', status: 'In Progress', boardPosition: 'b1' }),
    ];
    const qc = newQueryClient(tasks, 'proj');
    const onDragEnd = useDragReorder({ tasks, projectId: 'proj', queryClient: qc });

    // Drop t1 onto t2 → status → 'In Progress', then reorder above t2.
    // destList (no t1) in In Progress sorted: [t2@b0, t3@b1]; target = t2 idx 0.
    //   beforeId = null, afterId = t2 → reorder body: { after: 'b0' }
    await onDragEnd(event('t1', 't2'));
    expect(apiPatch).toHaveBeenCalledTimes(2);
    expect(apiPatch).toHaveBeenNthCalledWith(1, '/tasks/t1/status', { status: 'In Progress' });
    expect(apiPatch).toHaveBeenNthCalledWith(2, '/tasks/t1/reorder', { after: 'b0' });
  });
});

describe('useDragReorder — drop on column body', () => {
  it('cross-column drop on col:<status> issues only the status PATCH (no reorder)', async () => {
    const tasks: Task[] = [
      makeTask({ id: 't1', status: 'Todo', boardPosition: 'a0' }),
      makeTask({ id: 't2', status: 'In Progress', boardPosition: 'b0' }),
    ];
    const qc = newQueryClient(tasks, 'proj');
    const onDragEnd = useDragReorder({ tasks, projectId: 'proj', queryClient: qc });
    // Drop t1 onto the In Progress column body → status only.
    await onDragEnd(event('t1', 'col:In Progress'));
    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch).toHaveBeenCalledWith('/tasks/t1/status', { status: 'In Progress' });
  });

  it('same-column drop on the column body is a no-op', async () => {
    const tasks: Task[] = [makeTask({ id: 't1', status: 'Todo', boardPosition: 'a0' })];
    const qc = newQueryClient(tasks, 'proj');
    const onDragEnd = useDragReorder({ tasks, projectId: 'proj', queryClient: qc });
    await onDragEnd(event('t1', 'col:Todo'));
    expect(apiPatch).not.toHaveBeenCalled();
  });
});

describe('useDragReorder — optimistic update + rollback', () => {
  it('updates the cache to reflect the new status before the request resolves', async () => {
    const tasks: Task[] = [
      makeTask({ id: 't1', status: 'Todo', boardPosition: 'a0' }),
      makeTask({ id: 't2', status: 'Done', boardPosition: 'z0' }),
    ];
    const qc = newQueryClient(tasks, 'proj');
    // Resolve apiPatch asynchronously so we can observe the optimistic state.
    let resolveStatus: () => void = () => undefined;
    apiPatch.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveStatus = res;
        }),
    );
    const onDragEnd = useDragReorder({ tasks, projectId: 'proj', queryClient: qc });
    const p = onDragEnd(event('t1', 'col:Done'));
    // Cache shows t1 already in 'Done' before we resolve.
    const cached = qc.getQueryData<Task[]>(['tasks', 'project', 'proj']) ?? [];
    expect(cached.find((t) => t.id === 't1')?.status).toBe('Done');
    resolveStatus();
    await p;
  });

  it('rolls back to the prior status when the request fails', async () => {
    const tasks: Task[] = [
      makeTask({ id: 't1', status: 'Todo', boardPosition: 'a0' }),
      makeTask({ id: 't2', status: 'Done', boardPosition: 'z0' }),
    ];
    const qc = newQueryClient(tasks, 'proj');
    apiPatch.mockRejectedValueOnce(
      new ApiError(500, { type: 'about:blank', title: 'boom', status: 500 }),
    );
    const onDragEnd = useDragReorder({ tasks, projectId: 'proj', queryClient: qc });
    await onDragEnd(event('t1', 'col:Done'));
    const after = qc.getQueryData<Task[]>(['tasks', 'project', 'proj']) ?? [];
    expect(after.find((t) => t.id === 't1')?.status).toBe('Todo');
    expect(after.find((t) => t.id === 't1')?.boardPosition).toBe('a0');
  });
});
