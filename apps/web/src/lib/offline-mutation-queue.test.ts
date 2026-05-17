import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setDriverForTests,
  clear,
  createMemoryDriver,
  drain,
  enqueue,
  list,
  type QueuedMutation,
} from './offline-mutation-queue';

// =============================================================================
// offline-mutation-queue — covers:
//   - enqueue persists rows oldest-first.
//   - drain removes 2xx, leaves 409s as conflicts, keeps 5xx + stops.
//   - drain returns network errors as failed and aborts the rest of the run.
//   - enqueue generates a stable id when not supplied.
// =============================================================================

beforeEach(() => {
  __setDriverForTests(createMemoryDriver());
});

describe('offline-mutation-queue.enqueue', () => {
  it('persists the row with an auto-generated id and enqueuedAt timestamp', async () => {
    const before = Date.now();
    const row = await enqueue({
      method: 'PATCH',
      url: '/api/v1/tasks/abc',
      body: { title: 'updated' },
    });
    expect(row.id).toBeTruthy();
    expect(row.enqueuedAt).toBeGreaterThanOrEqual(before);
    const all = await list();
    expect(all).toHaveLength(1);
    expect(all[0]?.url).toBe('/api/v1/tasks/abc');
  });

  it('orders the queue oldest-first regardless of insert order', async () => {
    await enqueue({ method: 'PATCH', url: '/a', enqueuedAt: 200 });
    await enqueue({ method: 'PATCH', url: '/b', enqueuedAt: 100 });
    await enqueue({ method: 'PATCH', url: '/c', enqueuedAt: 300 });
    const all = await list();
    expect(all.map((m) => m.url)).toEqual(['/b', '/a', '/c']);
  });
});

describe('offline-mutation-queue.drain', () => {
  beforeEach(async () => {
    await clear();
  });

  it('removes mutations that succeed and reports them as drained', async () => {
    await enqueue({ method: 'PATCH', url: '/api/v1/tasks/1', enqueuedAt: 1 });
    await enqueue({ method: 'PATCH', url: '/api/v1/tasks/2', enqueuedAt: 2 });
    const executor = vi.fn(async () => new Response('{}', { status: 200 }));
    const r = await drain(executor);
    expect(r.drained.map((m) => m.url)).toEqual(['/api/v1/tasks/1', '/api/v1/tasks/2']);
    expect(r.conflicts).toEqual([]);
    expect(await list()).toEqual([]);
  });

  it('keeps 409 conflicts in the queue and reports them', async () => {
    await enqueue({ method: 'PATCH', url: '/api/v1/tasks/1', enqueuedAt: 1 });
    const executor = vi.fn(async () => new Response('{}', { status: 409 }));
    const r = await drain(executor);
    expect(r.conflicts).toHaveLength(1);
    expect(await list()).toHaveLength(1);
  });

  it('drops 4xx (not 409) mutations to avoid blocking the queue', async () => {
    await enqueue({ method: 'PATCH', url: '/api/v1/tasks/1', enqueuedAt: 1 });
    const executor = vi.fn(async () => new Response('{}', { status: 400 }));
    const r = await drain(executor);
    expect(r.failed).toHaveLength(1);
    expect(await list()).toEqual([]);
  });

  it('keeps 5xx mutations in the queue and stops draining the rest', async () => {
    await enqueue({ method: 'PATCH', url: '/api/v1/tasks/1', enqueuedAt: 1 });
    await enqueue({ method: 'PATCH', url: '/api/v1/tasks/2', enqueuedAt: 2 });
    const executor = vi.fn(
      async (m: QueuedMutation) =>
        new Response('{}', { status: m.url.endsWith('/1') ? 500 : 200 }),
    );
    const r = await drain(executor);
    expect(r.failed).toHaveLength(1);
    expect(r.drained).toEqual([]);
    // The /2 mutation should NOT have been attempted because we aborted on
    // the first transient error.
    expect(executor).toHaveBeenCalledTimes(1);
    expect(await list()).toHaveLength(2);
  });

  it('treats a thrown network error like a 5xx — keep + stop', async () => {
    await enqueue({ method: 'PATCH', url: '/api/v1/tasks/1', enqueuedAt: 1 });
    await enqueue({ method: 'PATCH', url: '/api/v1/tasks/2', enqueuedAt: 2 });
    const executor = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const r = await drain(executor);
    expect(r.failed).toHaveLength(1);
    expect(r.drained).toEqual([]);
    expect(await list()).toHaveLength(2);
  });
});
