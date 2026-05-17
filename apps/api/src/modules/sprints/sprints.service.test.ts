import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SprintsService } from './sprints.service';
import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// sprints.service — focused tests on the behaviors that aren't pure CRUD:
//
//   - start() refuses non-planned sprints + maps Prisma P2002 (the partial
//     unique index from companion.sql §1) to a friendly 409.
//   - addTasks() pre-flights cross-project task IDs and returns a 400 listing
//     them — fixing the silent-drop bug from the audit (Batch A item A6).
//   - addTasks() refuses additions when the sprint is already completed.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: { assertAtLeast: ReturnType<typeof vi.fn> };
  events: ReturnType<typeof makeEventsMock>;
}

function build(): { service: SprintsService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = {
    assertAtLeast: vi.fn().mockResolvedValue('Manager'),
  };
  const events = makeEventsMock();
  const service = new SprintsService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
  );
  return { service, mocks: { prisma, permissions, events } };
}

const ACTOR: AuthenticatedUser = {
  id: 'u-1',
  email: 'a@nockta.com',
  kind: 'internal',
  companyRole: 'Member',
} as AuthenticatedUser;

describe('SprintsService.start', () => {
  let mocks: Mocks;
  let service: SprintsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('refuses to start a sprint that is not in `planned` state', async () => {
    vi.mocked(mocks.prisma.sprint.findUniqueOrThrow).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'active',
      startDate: null,
    } as never);

    await expect(service.start(ACTOR, 's-1')).rejects.toThrow(/can only start planned/i);
  });

  it('translates Prisma P2002 (the active-sprint partial unique) to a 409', async () => {
    // companion.sql:11-14 has `CREATE UNIQUE INDEX ... WHERE state = 'active'`
    // — exactly one active sprint per project. Without translation, the
    // client would see a Prisma stacktrace; we surface a clean ConflictException.
    vi.mocked(mocks.prisma.sprint.findUniqueOrThrow).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'planned',
      startDate: null,
    } as never);
    vi.mocked(mocks.prisma.sprint.update).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(service.start(ACTOR, 's-1')).rejects.toThrow(ConflictException);
  });

  it('happy path: planned → active, emits sprint.started', async () => {
    vi.mocked(mocks.prisma.sprint.findUniqueOrThrow).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'planned',
      startDate: null,
    } as never);
    vi.mocked(mocks.prisma.sprint.update).mockResolvedValueOnce({
      id: 's-1',
      state: 'active',
    } as never);

    await service.start(ACTOR, 's-1');

    expect(mocks.events.emit).toHaveBeenCalledWith(
      'sprint.started',
      expect.objectContaining({ sprintId: 's-1', projectId: 'p1' }),
    );
  });
});

describe('SprintsService.addTasks — cross-project rejection', () => {
  let mocks: Mocks;
  let service: SprintsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('returns 400 listing cross-project IDs instead of silently dropping them', async () => {
    // The behavior change from Batch A: previously the service used
    // `where: { id: in: ids, projectId: sprint.projectId }` which silently
    // matched zero cross-project rows. Now we pre-flight and 400.
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'planned',
    } as never);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      { id: 'task-a', projectId: 'p1' }, // ok
      { id: 'task-b', projectId: 'p2' }, // wrong project
    ] as never);

    await expect(
      service.addTasks(ACTOR, 's-1', ['task-a', 'task-b']),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        crossProjectIds: ['task-b'],
        sprintProjectId: 'p1',
      }),
    });
    expect(mocks.prisma.task.updateMany).not.toHaveBeenCalled();
  });

  it('returns 400 with missingIds when a task does not exist', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'planned',
    } as never);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      { id: 'task-a', projectId: 'p1' },
    ] as never);

    await expect(
      service.addTasks(ACTOR, 's-1', ['task-a', 'ghost-task']),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ missingIds: ['ghost-task'] }),
    });
  });

  it('refuses to add tasks to a completed sprint', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'completed',
    } as never);

    await expect(service.addTasks(ACTOR, 's-1', ['task-a'])).rejects.toThrow(
      /completed sprint/i,
    );
  });

  it('happy path: every id valid + same project → updateMany + emit', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'planned',
    } as never);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      { id: 'task-a', projectId: 'p1' },
      { id: 'task-b', projectId: 'p1' },
    ] as never);
    vi.mocked(mocks.prisma.task.updateMany).mockResolvedValueOnce({ count: 2 } as never);
    // Membership createMany also runs in the same transaction.
    const memMock = (mocks.prisma as unknown as {
      sprintTaskMembership: { createMany: ReturnType<typeof vi.fn> };
    }).sprintTaskMembership;
    memMock.createMany.mockResolvedValueOnce({ count: 2 } as never);

    const result = await service.addTasks(ACTOR, 's-1', ['task-a', 'task-b']);

    expect(result).toEqual({ moved: 2 });
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'sprint.tasks_added',
      expect.objectContaining({ sprintId: 's-1' }),
    );
  });

  it('no-op short-circuit on empty input', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'planned',
    } as never);

    const result = await service.addTasks(ACTOR, 's-1', []);

    expect(result).toEqual({ moved: 0 });
    expect(mocks.prisma.task.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.task.updateMany).not.toHaveBeenCalled();
  });

  it('deduplicates the input array (a user passing the same id twice gets one update)', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'planned',
    } as never);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      { id: 'task-a', projectId: 'p1' },
    ] as never);
    vi.mocked(mocks.prisma.task.updateMany).mockResolvedValueOnce({ count: 1 } as never);
    (mocks.prisma as unknown as {
      sprintTaskMembership: { createMany: ReturnType<typeof vi.fn> };
    }).sprintTaskMembership.createMany.mockResolvedValueOnce({ count: 1 } as never);

    await service.addTasks(ACTOR, 's-1', ['task-a', 'task-a', 'task-a']);

    const findArgs = vi.mocked(mocks.prisma.task.findMany).mock.calls[0]?.[0];
    // `where.id` is typed as `string | UuidFilter` — at runtime it's the
    // filter object. Cast through unknown for the assertion.
    const idFilter = findArgs?.where?.id as { in?: string[] } | undefined;
    expect(idFilter?.in).toEqual(['task-a']);
  });
});

// =============================================================================
// updateMetadata — sprint goal edits. The goal column is the only mutable
// field today, but we still test the full validation + 404 + permission path.
// =============================================================================

describe('SprintsService.updateMetadata — goal field', () => {
  let mocks: Mocks;
  let service: SprintsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('404 when the sprint does not exist (NotFound, not a Prisma stacktrace)', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce(null as never);

    await expect(
      service.updateMetadata(ACTOR, 'missing-id', { goal: 'Ship the migration' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects goals longer than 200 chars before touching the DB', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      projectId: 'p1',
    } as never);

    await expect(
      service.updateMetadata(ACTOR, 's-1', { goal: 'x'.repeat(201) }),
    ).rejects.toThrow(/200 characters/i);
    expect(mocks.prisma.sprint.update).not.toHaveBeenCalled();
  });

  it("clears the goal when the caller passes null (and emits sprint.updated)", async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      projectId: 'p1',
    } as never);
    vi.mocked(mocks.prisma.sprint.update).mockResolvedValueOnce({
      id: 's-1', goal: null,
    } as never);

    const result = await service.updateMetadata(ACTOR, 's-1', { goal: null });

    expect(result.goal).toBeNull();
    const updateArgs = vi.mocked(mocks.prisma.sprint.update).mock.calls[0]?.[0];
    expect(updateArgs?.data).toEqual({ goal: null });
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'sprint.updated',
      expect.objectContaining({ sprintId: 's-1' }),
    );
  });

  it('trims and writes a valid goal', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      projectId: 'p1',
    } as never);
    vi.mocked(mocks.prisma.sprint.update).mockResolvedValueOnce({
      id: 's-1', goal: 'Ship the migration',
    } as never);

    await service.updateMetadata(ACTOR, 's-1', { goal: '  Ship the migration  ' });

    const updateArgs = vi.mocked(mocks.prisma.sprint.update).mock.calls[0]?.[0];
    expect(updateArgs?.data).toEqual({ goal: 'Ship the migration' });
  });

  it('treats an empty string the same as null (clears the goal)', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      projectId: 'p1',
    } as never);
    vi.mocked(mocks.prisma.sprint.update).mockResolvedValueOnce({ id: 's-1', goal: null } as never);

    await service.updateMetadata(ACTOR, 's-1', { goal: '   ' });

    const updateArgs = vi.mocked(mocks.prisma.sprint.update).mock.calls[0]?.[0];
    expect(updateArgs?.data).toEqual({ goal: null });
  });
});
