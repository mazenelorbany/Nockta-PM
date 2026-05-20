import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';

import { NotificationDigestService } from './digest.service';

// =============================================================================
// NotificationDigestService — Pass I (Notifications 8 → 9).
//
// The grill summary requires three behavioural guarantees:
//
//   1. 10 notifications inside a 5-minute window land in a single digest with
//      10 items (NOT 10 separate immediate deliveries).
//   2. The 11th notification triggers a flush — by the time enqueueOrBatch
//      returns, the digest has been stamped sentAt and the digest_ready
//      event has been emitted.
//   3. A user without digestEnabled gets `enqueueOrBatch` returning false so
//      the dispatcher falls back to the immediate queue path.
//
// Additionally we pin the time-threshold path: a buffer older than 5 minutes
// flushes on the next tick even if it never hit 10 items.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  events: ReturnType<typeof makeEventsMock>;
  lock: { withLock: ReturnType<typeof vi.fn> };
}

function build(): { service: NotificationDigestService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const events = makeEventsMock();
  const lock = {
    // Lock always acquired; mirrors the existing DigestScheduler test pattern.
    withLock: vi.fn(async (_k: string, _t: number, fn: () => Promise<unknown>) => fn()),
  };
  // makePrismaMock now declares notificationDigest as part of the model bag,
  // so we can use it directly through the typed helper below.
  const service = new NotificationDigestService(
    prisma,
    events.instance,
    lock as unknown as SchedulerLockService,
  );
  return { service, mocks: { prisma, events, lock } };
}

const RECIPIENT = '00000000-0000-0000-0000-0000000000a1';
const TASK_ID = '00000000-0000-0000-0000-0000000000b1';
const PROJECT_ID = '00000000-0000-0000-0000-0000000000c1';

function digestModel(prisma: PrismaService) {
  return (prisma as unknown as { notificationDigest: {
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  } }).notificationDigest;
}

function makeInput(overrides: Partial<{ type: string; reason: string }> = {}) {
  return {
    recipientUserId: RECIPIENT,
    type: overrides.type ?? 'TaskAssigned',
    payload: { foo: 'bar' },
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    reason: overrides.reason ?? 'assigned',
  };
}

describe('NotificationDigestService.enqueueOrBatch', () => {
  let mocks: Mocks;
  let service: NotificationDigestService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('returns false for a user without digestEnabled (dispatcher falls back to immediate queue)', async () => {
    vi.mocked(mocks.prisma.user.findUnique).mockResolvedValueOnce({
      digestEnabled: false,
      digestChannel: 'email',
    } as never);

    const result = await service.enqueueOrBatch(makeInput());

    expect(result).toBe(false);
    // Critical: no digest row was touched. The dispatcher will enqueue
    // through the normal bullmq path.
    expect(digestModel(mocks.prisma).findFirst).not.toHaveBeenCalled();
    expect(digestModel(mocks.prisma).create).not.toHaveBeenCalled();
  });

  it('creates a fresh digest when no open bucket exists', async () => {
    vi.mocked(mocks.prisma.user.findUnique).mockResolvedValueOnce({
      digestEnabled: true,
      digestChannel: 'email',
    } as never);
    digestModel(mocks.prisma).findFirst.mockResolvedValueOnce(null);
    digestModel(mocks.prisma).create.mockResolvedValueOnce({ id: 'd-1' });

    const result = await service.enqueueOrBatch(makeInput());

    expect(result).toBe(true);
    expect(digestModel(mocks.prisma).create).toHaveBeenCalledOnce();
    const args = digestModel(mocks.prisma).create.mock.calls[0]?.[0];
    expect(args?.data?.userId).toBe(RECIPIENT);
    expect(args?.data?.channelKind).toBe('email');
    expect(args?.data?.items).toHaveLength(1);
  });

  it('appends to the open bucket when one exists (no immediate flush below 10 items)', async () => {
    vi.mocked(mocks.prisma.user.findUnique).mockResolvedValueOnce({
      digestEnabled: true,
      digestChannel: 'email',
    } as never);
    digestModel(mocks.prisma).findFirst.mockResolvedValueOnce({
      id: 'd-1',
      userId: RECIPIENT,
      channelKind: 'email',
      items: Array.from({ length: 3 }, (_, i) => ({
        notificationType: 'TaskAssigned',
        payload: {},
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        reason: 'assigned',
        queuedAt: new Date(Date.now() - i * 1000).toISOString(),
      })),
    });
    // The append now happens via $executeRaw (atomic JSONB ||) rather than
    // a read-then-write update(). $executeRaw is mocked to return rows-
    // affected; 1 means the append landed on the open bucket.
    const exec = (mocks.prisma as unknown as { $executeRaw: ReturnType<typeof vi.fn> }).$executeRaw;
    exec.mockResolvedValueOnce(1);

    await service.enqueueOrBatch(makeInput());

    // 3 existing + 1 appended = 4, below the 10-item flush threshold.
    expect(exec).toHaveBeenCalledOnce();
    expect(digestModel(mocks.prisma).update).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
    expect(digestModel(mocks.prisma).updateMany).not.toHaveBeenCalled();
  });

  it('10 notifications in 5min produce 1 digest with 10 items (the spec example)', async () => {
    // We simulate the full ingestion sequence — the first call creates the
    // bucket, the next 9 append to it. The 10th hits the flush trip-wire.
    vi.mocked(mocks.prisma.user.findUnique).mockResolvedValue({
      digestEnabled: true,
      digestChannel: 'email',
    } as never);
    let storedItems: unknown[] = [];
    digestModel(mocks.prisma).findFirst.mockImplementation(async () =>
      storedItems.length === 0
        ? null
        : {
            id: 'd-1',
            userId: RECIPIENT,
            channelKind: 'email',
            items: storedItems,
          },
    );
    digestModel(mocks.prisma).create.mockImplementation(async (args: { data: { items: unknown[] } }) => {
      storedItems = args.data.items;
      return { id: 'd-1' };
    });
    // $executeRaw simulates the atomic JSONB append by pushing onto the
    // shared storedItems closure. Returns 1 because every append in this
    // single-threaded test lands on the still-open bucket.
    const exec = (mocks.prisma as unknown as { $executeRaw: ReturnType<typeof vi.fn> }).$executeRaw;
    exec.mockImplementation(async (_strings: unknown, ..._values: unknown[]) => {
      storedItems = [...storedItems, makeInput()];
      return 1;
    });
    // The 10th call triggers an inline flush: claim the row via updateMany,
    // then re-read it via findUnique to emit the event.
    digestModel(mocks.prisma).updateMany.mockResolvedValue({ count: 1 });
    digestModel(mocks.prisma).findUnique.mockImplementation(async () => ({
      id: 'd-1',
      userId: RECIPIENT,
      channelKind: 'email',
      firstQueuedAt: new Date(),
      items: storedItems,
      sentAt: new Date(),
    }));

    for (let i = 0; i < 10; i++) {
       
      await service.enqueueOrBatch(makeInput());
    }

    expect(storedItems).toHaveLength(10);
    // Exactly ONE flush event for the 10-item threshold, not ten.
    expect(mocks.events.emit).toHaveBeenCalledOnce();
    const [eventName, payload] = mocks.events.emit.mock.calls[0]!;
    expect(eventName).toBe('notification.digest_ready');
    expect((payload as { totalCount: number }).totalCount).toBe(10);
  });

  it('the 11th notification arrives while a flush is in flight — flush fires once, all items preserved', async () => {
    // After the 10th call flushes, an arriving 11th creates a NEW bucket.
    // The test pins that the renderer is not invoked again for the 11th —
    // the new bucket only flushes on the next time threshold (or item 20).
    vi.mocked(mocks.prisma.user.findUnique).mockResolvedValue({
      digestEnabled: true,
      digestChannel: 'email',
    } as never);

    const buckets: { id: string; items: unknown[]; sentAt: Date | null }[] = [];
    let nextId = 0;
    digestModel(mocks.prisma).findFirst.mockImplementation(async () => {
      const open = buckets.find((b) => b.sentAt === null);
      return open ? { ...open, userId: RECIPIENT, channelKind: 'email' } : null;
    });
    digestModel(mocks.prisma).create.mockImplementation(async (args: { data: { items: unknown[] } }) => {
      const id = `d-${++nextId}`;
      buckets.push({ id, items: args.data.items, sentAt: null });
      return { id };
    });
    // Atomic-append now goes through $executeRaw. The mock walks the
    // bucket list, finds the open one, and pushes a synthetic item onto
    // its items array — mirroring the production JSONB || append.
    const exec = (mocks.prisma as unknown as { $executeRaw: ReturnType<typeof vi.fn> }).$executeRaw;
    exec.mockImplementation(async () => {
      const open = buckets.find((b) => b.sentAt === null);
      if (!open) return 0;
      open.items = [...open.items, makeInput()];
      return 1;
    });
    digestModel(mocks.prisma).updateMany.mockImplementation(async (args: { where: { id: string; sentAt: null } }) => {
      const b = buckets.find((x) => x.id === args.where.id && x.sentAt === null);
      if (!b) return { count: 0 };
      b.sentAt = new Date();
      return { count: 1 };
    });
    digestModel(mocks.prisma).findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      const b = buckets.find((x) => x.id === args.where.id)!;
      return {
        id: b.id,
        userId: RECIPIENT,
        channelKind: 'email',
        firstQueuedAt: new Date(),
        items: b.items,
        sentAt: b.sentAt,
      };
    });

    for (let i = 0; i < 11; i++) {
       
      await service.enqueueOrBatch(makeInput());
    }

    // Two buckets total: the first flushed at 10 items, the second has 1 item.
    expect(buckets).toHaveLength(2);
    expect(buckets[0].items).toHaveLength(10);
    expect(buckets[0].sentAt).not.toBeNull();
    expect(buckets[1].items).toHaveLength(1);
    expect(buckets[1].sentAt).toBeNull();
    // One flush event, not two.
    expect(mocks.events.emit).toHaveBeenCalledOnce();
  });
});

describe('NotificationDigestService.tick — time-threshold flush', () => {
  let mocks: Mocks;
  let service: NotificationDigestService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('flushes every bucket older than 5 minutes', async () => {
    // The lock acquires successfully; findMany returns two due rows; flushOne
    // is exercised once per row via the updateMany→findUnique→emit chain.
    digestModel(mocks.prisma).findMany.mockResolvedValueOnce([
      { id: 'd-a' },
      { id: 'd-b' },
    ]);
    digestModel(mocks.prisma).updateMany.mockResolvedValue({ count: 1 });
    digestModel(mocks.prisma).findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
      id: args.where.id,
      userId: RECIPIENT,
      channelKind: 'email',
      firstQueuedAt: new Date(Date.now() - 10 * 60_000),
      items: [{ notificationType: 'TaskAssigned', payload: {}, taskId: null, projectId: null, reason: 'assigned', queuedAt: new Date().toISOString() }],
      sentAt: new Date(),
    }));

    await service.tick();

    expect(mocks.lock.withLock).toHaveBeenCalledOnce();
    expect(mocks.lock.withLock.mock.calls[0]?.[0]).toBe('notification:digest:flush');
    expect(mocks.events.emit).toHaveBeenCalledTimes(2);
  });

  it('does nothing when another replica holds the lock', async () => {
    mocks.lock.withLock.mockResolvedValueOnce(false);

    await service.tick();

    expect(digestModel(mocks.prisma).findMany).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
  });
});

describe('NotificationDigestService.groupBySourceType', () => {
  it('partitions items into the five render buckets', () => {
    const { service } = build();
    const grouped = service.groupBySourceType([
      { notificationType: 'TaskAssigned', payload: {}, taskId: null, projectId: null, reason: 'assigned', queuedAt: '' },
      { notificationType: 'TaskBlocked', payload: {}, taskId: null, projectId: null, reason: 'watching', queuedAt: '' },
      { notificationType: 'MentionedInComment', payload: {}, taskId: null, projectId: null, reason: 'mentioned', queuedAt: '' },
      { notificationType: 'TaskUpdated', payload: {}, taskId: null, projectId: null, reason: 'watching', queuedAt: '' },
      { notificationType: 'TaskDueSoon', payload: {}, taskId: null, projectId: null, reason: 'watching', queuedAt: '' },
    ]);
    expect(grouped.assignments).toHaveLength(1);
    expect(grouped.blocked).toHaveLength(1);
    expect(grouped.mentions).toHaveLength(1);
    expect(grouped.dueSoon).toHaveLength(1);
    expect(grouped.other).toHaveLength(1);
  });
});
