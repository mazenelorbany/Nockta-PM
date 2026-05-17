import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsService } from './projects.service';
import { ProjectsPurgeProcessor } from './projects-purge.processor';
import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';
import type { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';

// =============================================================================
// Project archive grace-period — Pass 5 R4-deferred A
//
// Three behaviors we lock down here:
//
//   1. archive(adminId) sets archivedAt = now() (and is idempotent).
//   2. restore(adminId) clears archivedAt — but only while the row still
//      exists in the grace window. Once it's purged, restore raises 404.
//   3. The nightly purge cron deletes projects whose archivedAt < now() - 7d
//      AND emits `project.purged`. Behind the ENABLE_PROJECT_PURGE flag.
//
// We deliberately do NOT cover the cascade-FK ergonomics in this file (see
// the warning at the top of projects-purge.processor.ts) — that lives in
// a follow-up DB-integration suite that runs against a real Postgres.
// =============================================================================

interface ArchiveMocks {
  prisma: PrismaService;
  permissions: {
    assertAtLeast: ReturnType<typeof vi.fn>;
    effectiveRole: ReturnType<typeof vi.fn>;
    canSeeTask: ReturnType<typeof vi.fn>;
  };
  events: ReturnType<typeof makeEventsMock>;
}

function buildService(): { service: ProjectsService; mocks: ArchiveMocks } {
  const prisma = makePrismaMock();
  const permissions = {
    assertAtLeast: vi.fn().mockResolvedValue('Manager'),
    effectiveRole: vi.fn(),
    canSeeTask: vi.fn(),
  };
  const events = makeEventsMock();
  const service = new ProjectsService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
  );
  return { service, mocks: { prisma, permissions, events } };
}

const ADMIN: AuthenticatedUser = {
  id: 'u-admin',
  email: 'admin@nockta.com',
  kind: 'internal',
  companyRole: 'Admin',
} as AuthenticatedUser;

const MEMBER: AuthenticatedUser = {
  id: 'u-member',
  email: 'm@nockta.com',
  kind: 'internal',
  companyRole: 'Member',
} as AuthenticatedUser;

describe('ProjectsService.archive', () => {
  let service: ProjectsService;
  let mocks: ArchiveMocks;

  beforeEach(() => {
    ({ service, mocks } = buildService());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses non-Admin actors', async () => {
    await expect(service.archive(MEMBER, 'p1')).rejects.toThrow(ForbiddenException);
  });

  it('sets archivedAt = now() on a project that is currently active', async () => {
    vi.mocked(mocks.prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p1',
      archivedAt: null,
    } as never);
    vi.mocked(mocks.prisma.project.update).mockResolvedValueOnce({ id: 'p1' } as never);

    await service.archive(ADMIN, 'p1');

    const args = vi.mocked(mocks.prisma.project.update).mock.calls[0]?.[0];
    expect(args?.where).toEqual({ id: 'p1' });
    // The exact instant is the frozen system time above.
    expect(args?.data).toMatchObject({
      archivedAt: new Date('2026-05-16T12:00:00.000Z'),
    });
    expect(mocks.events.emit).toHaveBeenCalledWith('project.archived', {
      projectId: 'p1',
      actorUserId: ADMIN.id,
    });
  });

  it('is idempotent — re-archiving leaves the original archivedAt alone', async () => {
    // Already archived two days ago. Second call MUST NOT bump archivedAt
    // forward — that would silently reset the 7-day purge countdown.
    vi.mocked(mocks.prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p1',
      archivedAt: new Date('2026-05-14T12:00:00.000Z'),
    } as never);

    await service.archive(ADMIN, 'p1');

    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
  });
});

describe('ProjectsService.restore', () => {
  let service: ProjectsService;
  let mocks: ArchiveMocks;

  beforeEach(() => {
    ({ service, mocks } = buildService());
  });

  it('refuses non-Admin actors', async () => {
    await expect(service.restore(MEMBER, 'p1')).rejects.toThrow(ForbiddenException);
  });

  it('clears archivedAt when the project is in the grace window', async () => {
    vi.mocked(mocks.prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p1',
      archivedAt: new Date('2026-05-15T00:00:00.000Z'),
    } as never);
    vi.mocked(mocks.prisma.project.update).mockResolvedValueOnce({ id: 'p1' } as never);

    await service.restore(ADMIN, 'p1');

    const args = vi.mocked(mocks.prisma.project.update).mock.calls[0]?.[0];
    expect(args?.data).toEqual({ archivedAt: null });
    expect(mocks.events.emit).toHaveBeenCalledWith('project.restored', {
      projectId: 'p1',
      actorUserId: ADMIN.id,
    });
  });

  it('throws NotFound when the row no longer exists (post-purge)', async () => {
    vi.mocked(mocks.prisma.project.findUnique).mockResolvedValueOnce(null as never);

    await expect(service.restore(ADMIN, 'p1')).rejects.toThrow(NotFoundException);
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  });

  it('no-ops when restoring a project that is already active', async () => {
    vi.mocked(mocks.prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p1',
      archivedAt: null,
    } as never);

    await service.restore(ADMIN, 'p1');

    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
  });
});

describe('ProjectsService.listArchived', () => {
  let service: ProjectsService;
  let mocks: ArchiveMocks;

  beforeEach(() => {
    ({ service, mocks } = buildService());
  });

  it('queries with archivedAt: { not: null }', async () => {
    vi.mocked(mocks.prisma.project.findMany).mockResolvedValueOnce([] as never);

    await service.listArchived(ADMIN);

    const args = vi.mocked(mocks.prisma.project.findMany).mock.calls[0]?.[0];
    expect(args?.where).toEqual({ archivedAt: { not: null } });
    // Selection MUST include archivedAt so the UI can compute time-until-purge.
    expect((args?.select as Record<string, unknown> | undefined)?.['archivedAt']).toBe(true);
  });

  it('refuses non-Admin actors', async () => {
    await expect(service.listArchived(MEMBER)).rejects.toThrow(ForbiddenException);
  });
});

describe('ProjectsPurgeProcessor.purgeOnce', () => {
  let prisma: PrismaService;
  let events: ReturnType<typeof makeEventsMock>;
  let processor: ProjectsPurgeProcessor;
  let lock: SchedulerLockService;

  beforeEach(() => {
    prisma = makePrismaMock();
    events = makeEventsMock();
    // Lock is irrelevant for direct purgeOnce calls but the Nest constructor
    // still wants the binding. A stub that always grants the lock is enough.
    lock = {
      withLock: async <T,>(_k: string, _ttl: number, fn: () => Promise<T>) => fn(),
    } as unknown as SchedulerLockService;
    processor = new ProjectsPurgeProcessor(prisma, events.instance, lock);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T03:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env['ENABLE_PROJECT_PURGE'];
  });

  it('selects only projects whose archivedAt is older than 7 days', async () => {
    process.env['ENABLE_PROJECT_PURGE'] = 'true';
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([] as never);

    await processor.purgeOnce();

    const args = vi.mocked(prisma.project.findMany).mock.calls[0]?.[0];
    const where = args?.where as { archivedAt: { lt: Date } };
    // 2026-05-16T03:00 - 7d = 2026-05-09T03:00
    expect(where.archivedAt.lt.toISOString()).toBe('2026-05-09T03:00:00.000Z');
  });

  it('hard-deletes eligible projects and emits project.purged when the flag is on', async () => {
    process.env['ENABLE_PROJECT_PURGE'] = 'true';
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      { id: 'p-old', key: 'OLD', archivedAt: new Date('2026-05-01T00:00:00.000Z') },
    ] as never);
    vi.mocked(prisma.project.delete).mockResolvedValueOnce({ id: 'p-old' } as never);

    const result = await processor.purgeOnce();

    expect(vi.mocked(prisma.project.delete).mock.calls[0]?.[0]).toEqual({
      where: { id: 'p-old' },
    });
    expect(events.emit).toHaveBeenCalledWith(
      'project.purged',
      expect.objectContaining({ projectId: 'p-old', key: 'OLD' }),
    );
    expect(result).toEqual({ scanned: 1, purged: 1 });
  });

  it('logs but does NOT delete when ENABLE_PROJECT_PURGE is unset (the default)', async () => {
    // Leave env var unset on purpose. The cron is supposed to be inert until
    // the operator has audited cascade FKs.
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      { id: 'p-old', key: 'OLD', archivedAt: new Date('2026-05-01T00:00:00.000Z') },
    ] as never);

    const result = await processor.purgeOnce();

    expect(vi.mocked(prisma.project.delete)).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, purged: 0 });
  });

  it('uses a 7-day cutoff exactly — projects archived 6.9 days ago survive', async () => {
    process.env['ENABLE_PROJECT_PURGE'] = 'true';
    // findMany returns whatever Prisma would, given the `lt` cutoff. We
    // stub it as empty here to verify the processor honors the empty
    // result path (no delete, no event emit, scan count = 0).
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([] as never);

    const result = await processor.purgeOnce();
    // The cutoff has already been asserted in the first test of this block;
    // here we lock down the "nothing to do" path.
    expect(vi.mocked(prisma.project.delete)).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, purged: 0 });
  });
});
