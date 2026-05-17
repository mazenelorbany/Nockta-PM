import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorklogService } from './worklog.service';
import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// worklog.service — covers:
//   - start() stops any other running timer for the user (one-active rule).
//   - stop() computes seconds = (endedAt - startedAt) / 1000, rounded down.
//   - logManual() rejects 0 / negative / NaN seconds.
//   - delete() requires Manager when deleting someone else's entry.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: { assertAtLeast: ReturnType<typeof vi.fn>; canSeeTask: ReturnType<typeof vi.fn> };
}

function build(): { service: WorklogService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = {
    assertAtLeast: vi.fn().mockResolvedValue('Manager'),
    canSeeTask: vi.fn().mockResolvedValue(true),
  };
  // The default mock factory now ships a `worklog` model, but we override it
  // here with a hand-shaped spy bag so each test can vi.mocked-without-cast
  // against the exact methods this service uses (no `aggregate`, etc.).
  (prisma as unknown as { worklog: Record<string, ReturnType<typeof vi.fn>> }).worklog = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  };
  const events = makeEventsMock();
  const service = new WorklogService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
  );
  return { service, mocks: { prisma, permissions } };
}

const ACTOR: AuthenticatedUser = {
  id: 'u-1',
  email: 'a@nockta.com',
  kind: 'internal',
  companyRole: 'Member',
} as AuthenticatedUser;

function worklog(mocks: Mocks): Record<string, ReturnType<typeof vi.fn>> {
  return (mocks.prisma as unknown as { worklog: Record<string, ReturnType<typeof vi.fn>> })
    .worklog;
}

describe('WorklogService.start', () => {
  let mocks: Mocks;
  let service: WorklogService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('stops any other running timer for the same user before starting a new one', async () => {
    // The one-active-timer rule is critical because the partial unique
    // index (companion.sql §6) refuses two NULL endedAt rows per user. If
    // start() forgets to close the old row first, the create() throws.
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-1',
      projectId: 'p1',
      visibility: 'internal',
    } as never);
    worklog(mocks).updateMany.mockResolvedValueOnce({ count: 1 });
    worklog(mocks).create.mockResolvedValueOnce({ id: 'w-1' });

    await service.start(ACTOR, 't-1');

    expect(worklog(mocks).updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: ACTOR.id, endedAt: null },
        data: expect.objectContaining({ endedAt: expect.any(Date) as Date, seconds: 0 }),
      }),
    );
    expect(worklog(mocks).create).toHaveBeenCalled();
  });
});

describe('WorklogService.stop', () => {
  let mocks: Mocks;
  let service: WorklogService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('rejects when no running timer exists for this task', async () => {
    worklog(mocks).findFirst.mockResolvedValueOnce(null);
    await expect(service.stop(ACTOR, 't-1')).rejects.toThrow(BadRequestException);
  });

  it('computes seconds from startedAt → now, rounded down', async () => {
    // Mock startedAt to exactly 3600.999s ago. Expect floor → 3600.
    const startedAt = new Date(Date.now() - 3_600_999);
    worklog(mocks).findFirst.mockResolvedValueOnce({
      id: 'w-1',
      startedAt,
    });
    worklog(mocks).update.mockResolvedValueOnce({ id: 'w-1', seconds: 3600 });

    await service.stop(ACTOR, 't-1');

    const args = worklog(mocks).update.mock.calls[0]?.[0];
    expect(args?.data?.seconds).toBe(3600);
  });
});

describe('WorklogService.logManual', () => {
  let mocks: Mocks;
  let service: WorklogService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('rejects negative seconds', async () => {
    await expect(
      service.logManual(ACTOR, 't-1', { seconds: -10 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects zero seconds', async () => {
    await expect(service.logManual(ACTOR, 't-1', { seconds: 0 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects NaN seconds', async () => {
    await expect(
      service.logManual(ACTOR, 't-1', { seconds: NaN }),
    ).rejects.toThrow(BadRequestException);
  });

  it('floors fractional seconds (e.g. 3661.7 → 3661)', async () => {
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p1',
      visibility: 'internal',
    } as never);
    worklog(mocks).create.mockResolvedValueOnce({ id: 'w-1', seconds: 3661 });

    await service.logManual(ACTOR, 't-1', { seconds: 3661.7 });

    const args = worklog(mocks).create.mock.calls[0]?.[0];
    expect(args?.data?.seconds).toBe(3661);
  });

  it('defaults startedAt to (now - seconds) when not provided', async () => {
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p1',
      visibility: 'internal',
    } as never);
    worklog(mocks).create.mockResolvedValueOnce({ id: 'w-1' });

    const before = Date.now();
    await service.logManual(ACTOR, 't-1', { seconds: 60 });
    const after = Date.now();

    const args = worklog(mocks).create.mock.calls[0]?.[0];
    const startedAt = args?.data?.startedAt as Date;
    // Should be roughly 60 seconds in the past.
    const startMs = startedAt.getTime();
    expect(startMs).toBeGreaterThanOrEqual(before - 60_001);
    expect(startMs).toBeLessThanOrEqual(after - 59_000);
  });
});

describe('WorklogService.delete — authorization', () => {
  let mocks: Mocks;
  let service: WorklogService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('does NOT require Manager when deleting your own entry', async () => {
    worklog(mocks).findUnique.mockResolvedValueOnce({
      id: 'w-1',
      userId: ACTOR.id,
      task: { projectId: 'p1' },
    });
    worklog(mocks).delete.mockResolvedValueOnce({} as never);

    await service.delete(ACTOR, 'w-1');

    expect(mocks.permissions.assertAtLeast).not.toHaveBeenCalled();
  });

  it('requires Manager when deleting someone else\'s entry', async () => {
    worklog(mocks).findUnique.mockResolvedValueOnce({
      id: 'w-1',
      userId: 'someone-else',
      task: { projectId: 'p1' },
    });
    worklog(mocks).delete.mockResolvedValueOnce({} as never);

    await service.delete(ACTOR, 'w-1');

    expect(mocks.permissions.assertAtLeast).toHaveBeenCalledWith(ACTOR, 'p1', 'Manager');
  });

  it('returns 404 when worklog does not exist', async () => {
    worklog(mocks).findUnique.mockResolvedValueOnce(null);
    await expect(service.delete(ACTOR, 'missing')).rejects.toThrow(NotFoundException);
  });
});

// =============================================================================
// getMyActive — used by the web client on app load to hydrate the timer chip
// from server-side state instead of relying on local storage.
// =============================================================================

describe('WorklogService.getMyActive', () => {
  let mocks: Mocks;
  let service: WorklogService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it("returns null (not 404) when the user has no running timer", async () => {
    worklog(mocks).findFirst.mockResolvedValueOnce(null);

    const out = await service.getMyActive(ACTOR);

    expect(out).toBeNull();
  });

  it('flattens the joined task into a display-ready key (PROJ-N) and trims the payload', async () => {
    const startedAt = new Date('2026-03-01T10:00:00Z');
    worklog(mocks).findFirst.mockResolvedValueOnce({
      id: 'w-active',
      taskId: 't-1',
      startedAt,
      note: 'refactoring login',
      task: {
        id: 't-1',
        title: 'Login bug',
        projectId: 'p1',
        keyNumber: 42,
        project: { key: 'WEB' },
      },
    });

    const out = await service.getMyActive(ACTOR);

    expect(out).toEqual({
      id: 'w-active',
      taskId: 't-1',
      startedAt,
      note: 'refactoring login',
      task: { id: 't-1', title: 'Login bug', projectId: 'p1', key: 'WEB-42' },
    });
  });

  it('scopes findFirst to (userId, endedAt: null)', async () => {
    worklog(mocks).findFirst.mockResolvedValueOnce(null);

    await service.getMyActive(ACTOR);

    const args = worklog(mocks).findFirst.mock.calls[0]?.[0];
    expect(args?.where).toEqual({ userId: ACTOR.id, endedAt: null });
  });
});
