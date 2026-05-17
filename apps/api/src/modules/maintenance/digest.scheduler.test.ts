import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DigestScheduler } from './digest.scheduler';
import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';

// =============================================================================
// digest.scheduler — three regressions to guard:
//
//   1. Hour-gate. Without it, every 5-minute tick would do real DB work and
//      send 12 digests per day per user.
//   2. lastFiredOn idempotency. Two ticks inside the same UTC 08:00 hour must
//      not double-write digest rows for this replica.
//   3. Cross-replica lock. withLock returning `false` means another replica
//      already owns the slot — we must not call into prisma at all in that case.
//
// The scheduler's tick() is private; we exercise it via the public
// onModuleInit + a single fake-timer advance, but it's cleaner to invoke the
// method directly through a typed handle so each test pins exactly one branch.
// =============================================================================

// `lastFiredOn` is private on DigestScheduler — intersecting with the class
// would reduce to `never`. Use the structural type and cast through unknown.
type Internal = { tick(): Promise<void>; lastFiredOn: string | null };

interface Mocks {
  prisma: PrismaService;
  lock: { withLock: ReturnType<typeof vi.fn> };
}

function build(): { scheduler: Internal; mocks: Mocks } {
  const prisma = makePrismaMock();
  // Default: lock is always acquired. Individual tests override.
  const lock = {
    withLock: vi.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
  };
  const scheduler = new DigestScheduler(
    prisma,
    lock as unknown as SchedulerLockService,
  ) as unknown as Internal;
  return { scheduler, mocks: { prisma, lock } };
}

describe('DigestScheduler.tick', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('short-circuits when the UTC hour is not 08:00 — no DB calls, no lock attempt', async () => {
    // The hour-gate is intentionally the FIRST thing in tick() so non-firing
    // hours stay free. A regression that moves the gate after the lock acquire
    // would burn a Redis SETNX every 5 minutes — small but unnecessary.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T03:00:00.000Z')); // 03:00 UTC
    const { scheduler, mocks } = build();

    await scheduler.tick();

    expect(mocks.lock.withLock).not.toHaveBeenCalled();
    expect(mocks.prisma.notificationPreference.findMany).not.toHaveBeenCalled();
  });

  it('short-circuits when lastFiredOn already matches today (same-day re-entry)', async () => {
    // After a successful run, subsequent ticks within the same UTC day must
    // bail before the lock acquisition. Otherwise a second run would write
    // duplicate DailyDigest rows for every digest-mode user.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T08:00:00.000Z'));
    const { scheduler, mocks } = build();
    scheduler.lastFiredOn = '2026-05-16';

    await scheduler.tick();

    expect(mocks.lock.withLock).not.toHaveBeenCalled();
  });

  it('acquires the cross-replica lock when the hour matches', async () => {
    // The lock key must be deterministic — "digest:tick" — so all replicas
    // contend on the same Redis key. A typo here would break leader election.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T08:00:00.000Z'));
    const { scheduler, mocks } = build();
    vi.mocked(mocks.prisma.notificationPreference.findMany).mockResolvedValueOnce(
      [] as never,
    );

    await scheduler.tick();

    expect(mocks.lock.withLock).toHaveBeenCalledOnce();
    expect(mocks.lock.withLock.mock.calls[0]?.[0]).toBe('digest:tick');
  });

  it('skips work entirely when another replica already holds the lock', async () => {
    // withLock returns false on contention. We must not touch prisma — that's
    // the whole point of the cross-replica gate.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T08:00:00.000Z'));
    const { scheduler, mocks } = build();
    mocks.lock.withLock.mockResolvedValueOnce(false);

    await scheduler.tick();

    expect(mocks.prisma.notificationPreference.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.notification.create).not.toHaveBeenCalled();
  });

  it('sets lastFiredOn after a successful run with zero digest users', async () => {
    // Even when there's nothing to do, we must record today's run so the next
    // tick this hour short-circuits. Skipping this update would cause
    // up-to-12 Redis lock attempts per hour for no benefit.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T08:00:00.000Z'));
    const { scheduler, mocks } = build();
    vi.mocked(mocks.prisma.notificationPreference.findMany).mockResolvedValueOnce(
      [] as never,
    );

    await scheduler.tick();

    expect(scheduler.lastFiredOn).toBe('2026-05-16');
  });

  it('creates one DailyDigest row per digest-mode user with non-empty inbox', async () => {
    // Bundles all in-app notifications from the last 24h into ONE row per
    // user, regardless of how many channels they configured.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T08:00:00.000Z'));
    const { scheduler, mocks } = build();
    vi.mocked(mocks.prisma.notificationPreference.findMany).mockResolvedValueOnce([
      { userId: 'u-1' },
      { userId: 'u-2' },
    ] as never);
    // Neither user is snoozed.
    vi.mocked(mocks.prisma.notificationPreference.findFirst).mockResolvedValue(
      null as never,
    );
    vi.mocked(mocks.prisma.notification.findMany)
      .mockResolvedValueOnce([
        { id: 'n-a', type: 'TaskAssigned' },
        { id: 'n-b', type: 'TaskAssigned' },
        { id: 'n-c', type: 'CommentAdded' },
      ] as never)
      .mockResolvedValueOnce([] as never); // u-2 has nothing → no digest

    await scheduler.tick();

    expect(mocks.prisma.notification.create).toHaveBeenCalledTimes(1);
    const args = vi.mocked(mocks.prisma.notification.create).mock.calls[0]?.[0];
    expect(args?.data?.recipientUserId).toBe('u-1');
    expect(args?.data?.type).toBe('DailyDigest');
    expect(args?.data?.payload).toEqual(
      expect.objectContaining({
        total: 3,
        groupedByType: { TaskAssigned: 2, CommentAdded: 1 },
      }),
    );
  });

  it('skips users whose digest preferences are currently snoozed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T08:00:00.000Z'));
    const { scheduler, mocks } = build();
    vi.mocked(mocks.prisma.notificationPreference.findMany).mockResolvedValueOnce([
      { userId: 'u-1' },
    ] as never);
    // A live snooze row matches → user is skipped before the inbox query.
    vi.mocked(mocks.prisma.notificationPreference.findFirst).mockResolvedValueOnce({
      userId: 'u-1',
      snoozeUntil: new Date('2026-05-17T08:00:00.000Z'),
    } as never);

    await scheduler.tick();

    expect(mocks.prisma.notification.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.notification.create).not.toHaveBeenCalled();
  });
});
