import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { TasksService } from './tasks.service';

// tasks.service — pins the rules that aren't pure CRUD: per-actor permission
// gates on create, hierarchy walking on update (cycles + Subtask-in-chain),
// parent-completion gate on changeStatus, status-preset validation, the
// watcher-delete swallow-only-on-P2025 contract, and the always-bottom-of-
// column rule for changeStatus. Direct instantiation, no NestJS DI.

interface Mocks {
  prisma: PrismaService;
  permissions: {
    assertAtLeast: ReturnType<typeof vi.fn>;
    canSeeTask: ReturnType<typeof vi.fn>;
    effectiveRole: ReturnType<typeof vi.fn>;
  };
  events: ReturnType<typeof makeEventsMock>;
}

function build(): { service: TasksService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = {
    assertAtLeast: vi.fn().mockResolvedValue('Manager'),
    canSeeTask: vi.fn().mockResolvedValue(true),
    effectiveRole: vi.fn().mockResolvedValue('Manager'),
  };
  const events = makeEventsMock();
  const service = new TasksService(prisma, permissions as unknown as PermissionsService, events.instance);
  return { service, mocks: { prisma, permissions, events } };
}

function buildActor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'actor-1', email: 'a@nockta.com', kind: 'internal', companyRole: 'Member', ...overrides } as AuthenticatedUser;
}

function stubProject(prisma: PrismaService, overrides: Record<string, unknown> = {}) {
  vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
    id: 'p1', key: 'PRJ', workflowPreset: 'engineering', sprintsEnabled: false, archivedAt: null, ...overrides,
  } as never);
}

describe('TasksService.create', () => {
  let mocks: Mocks;
  let service: TasksService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('admits a Client-role actor and runs the bug-only path', async () => {
    mocks.permissions.effectiveRole.mockResolvedValueOnce('Client');
    stubProject(mocks.prisma);
    vi.mocked(mocks.prisma.task.findFirst).mockResolvedValueOnce(null);
    vi.mocked(mocks.prisma.$transaction).mockResolvedValueOnce({
      id: 't-1', projectId: 'p1', keyNumber: 7, assigneeUserId: null, title: 'x',
    } as never);

    await service.create(buildActor({ kind: 'client', companyRole: null }), {
      projectId: 'p1', title: 'broken',
    });

    expect(mocks.permissions.effectiveRole).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'client' }), 'p1',
    );
  });

  it('rejects a Viewer-role actor on create', async () => {
    mocks.permissions.effectiveRole.mockResolvedValueOnce('Viewer');
    stubProject(mocks.prisma);

    await expect(
      service.create(buildActor(), { projectId: 'p1', title: 'work' }),
    ).rejects.toThrow(/Contributor or higher/);
  });

  it('admits a Contributor-role actor on the full-create path', async () => {
    mocks.permissions.effectiveRole.mockResolvedValueOnce('Contributor');
    stubProject(mocks.prisma);
    vi.mocked(mocks.prisma.task.findFirst).mockResolvedValueOnce(null);
    vi.mocked(mocks.prisma.$transaction).mockResolvedValueOnce({
      id: 't-1', projectId: 'p1', keyNumber: 1, assigneeUserId: null, title: 'work',
    } as never);

    await service.create(buildActor(), { projectId: 'p1', title: 'work' });

    expect(mocks.permissions.effectiveRole).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'internal' }), 'p1',
    );
  });

  it('rejects a parent task that lives in a different project', async () => {
    stubProject(mocks.prisma);
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p-OTHER', type: 'Story',
    } as never);

    await expect(
      service.create(buildActor(), {
        projectId: 'p1', title: 'orphan', parentTaskId: 'parent-other',
      }),
    ).rejects.toThrow(/same project/i);
  });

  it('refuses to create a Subtask without a parent', async () => {
    stubProject(mocks.prisma);

    await expect(
      service.create(buildActor(), { projectId: 'p1', title: 'x', type: 'Subtask' }),
    ).rejects.toThrow(/Subtask.*parent/i);
  });

  it('refuses to create an Epic with a parent', async () => {
    stubProject(mocks.prisma);
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p1', type: 'Story',
    } as never);

    await expect(
      service.create(buildActor(), {
        projectId: 'p1', title: 'epic', type: 'Epic', parentTaskId: 'p-story',
      }),
    ).rejects.toThrow(/Epic.*parent/i);
  });

  it('client-bug coerces type=Bug, visibility=client_visible, reportedByClient=true', async () => {
    mocks.permissions.effectiveRole.mockResolvedValueOnce('Client');
    stubProject(mocks.prisma);
    vi.mocked(mocks.prisma.task.findFirst).mockResolvedValueOnce(null);
    let captured: Record<string, unknown> | undefined;
    vi.mocked(mocks.prisma.$transaction).mockImplementationOnce(async (cb) => {
      vi.mocked(mocks.prisma.project.update).mockResolvedValueOnce({ nextTaskNumber: 4 } as never);
      vi.mocked(mocks.prisma.task.create).mockImplementationOnce((async (args: { data: Record<string, unknown> }) => {
        captured = args.data;
        return { id: 't-1', projectId: 'p1', keyNumber: 3, title: 'x', assigneeUserId: null };
      }) as never);
      return (cb as (t: unknown) => unknown)(mocks.prisma);
    });

    // Even if a client passes visibility='internal' + type='Story', the
    // service must force Bug + client_visible.
    await service.create(buildActor({ kind: 'client', companyRole: null }), {
      projectId: 'p1', title: 'login broken', visibility: 'internal', type: 'Story',
    });

    expect(captured?.type).toBe('Bug');
    expect(captured?.visibility).toBe('client_visible');
    expect(captured?.reportedByClient).toBe(true);
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'client.reported_bug', expect.objectContaining({ taskId: 't-1' }),
    );
  });
});

describe('TasksService.changeStatus', () => {
  let mocks: Mocks;
  let service: TasksService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  function stubTask(overrides: Record<string, unknown> = {}) {
    vi.mocked(mocks.prisma.task.findUniqueOrThrow).mockResolvedValueOnce({
      id: 't-1',
      projectId: 'p1',
      status: 'Todo',
      subtasks: [],
      project: { workflowPreset: 'engineering', key: 'PRJ' },
      ...overrides,
    } as never);
    // The new transition gate calls projectWorkflowTransition.findMany. Seed
    // it with a permissive set for the engineering preset so existing tests
    // that exercise a legal transition (e.g. Todo → In Progress) still pass
    // without per-test stubs. Tests that exercise an illegal transition
    // override this with their own mockResolvedValueOnce(...).
    vi.mocked(
      (mocks.prisma as unknown as {
        projectWorkflowTransition: { findMany: ReturnType<typeof vi.fn> };
      }).projectWorkflowTransition.findMany,
    ).mockResolvedValueOnce([
      { fromStatus: 'Todo', toStatus: 'In Progress' },
      { fromStatus: 'In Progress', toStatus: 'Todo' },
      { fromStatus: 'In Progress', toStatus: 'In Review' },
      { fromStatus: 'In Review', toStatus: 'Testing' },
      { fromStatus: 'Testing', toStatus: 'Done' },
      { fromStatus: 'Done', toStatus: 'In Progress' },
    ] as never);
    // The custom-statuses feature added a ProjectStatus.findMany on every
    // changeStatus call to source the valid + done sets. Returning [] here
    // triggers the legacy preset-constant fallback, which keeps existing
    // assertions wired against the engineering-preset constants.
    vi.mocked(
      (mocks.prisma as unknown as {
        projectStatus: { findMany: ReturnType<typeof vi.fn> };
      }).projectStatus.findMany,
    ).mockResolvedValueOnce([] as never);
  }

  it('rejects a status that does not exist in the project preset', async () => {
    // 'In Review' is engineering-only; not on the generic preset.
    stubTask({ project: { workflowPreset: 'generic', key: 'PRJ' } });

    await expect(
      service.changeStatus(buildActor(), 't-1', 'In Review'),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns early (no update, no event) when previous === new', async () => {
    stubTask({ status: 'In Progress' });

    const result = await service.changeStatus(buildActor(), 't-1', 'In Progress');

    expect(result).toBeTruthy();
    expect(mocks.prisma.task.update).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
  });

  it('refuses to move parent to Done while subtasks are incomplete', async () => {
    stubTask({
      status: 'In Progress',
      subtasks: [
        { id: 'sub-a', status: 'Done' },
        { id: 'sub-b', status: 'In Progress' },
      ],
    });

    await expect(
      service.changeStatus(buildActor(), 't-1', 'Done'),
    ).rejects.toThrow(ConflictException);
  });

  it('emits task.status_changed with fromStatus/toStatus on success', async () => {
    stubTask({ status: 'Todo' });
    vi.mocked(mocks.prisma.task.findFirst).mockResolvedValueOnce(null);
    vi.mocked(mocks.prisma.task.update).mockResolvedValueOnce({
      id: 't-1', status: 'In Progress',
    } as never);

    await service.changeStatus(buildActor(), 't-1', 'In Progress');

    expect(mocks.events.emit).toHaveBeenCalledWith(
      'task.status_changed',
      expect.objectContaining({
        taskId: 't-1', fromStatus: 'Todo', toStatus: 'In Progress',
      }),
    );
  });

  it('always places the moved card at the bottom of the destination column', async () => {
    // Asserts (a) the last-in-column lookup is scoped to the new status and
    // (b) boardPosition is written as a non-empty fractional-index key.
    stubTask({ status: 'Todo' });
    vi.mocked(mocks.prisma.task.findFirst).mockResolvedValueOnce({
      boardPosition: 'a3',
    } as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValueOnce({
      id: 't-1', status: 'In Progress',
    } as never);

    await service.changeStatus(buildActor(), 't-1', 'In Progress');

    const last = vi.mocked(mocks.prisma.task.findFirst).mock.calls[0]?.[0];
    expect(last?.where).toMatchObject({ projectId: 'p1', status: 'In Progress' });
    expect(last?.orderBy).toEqual({ boardPosition: 'desc' });
    const update = vi.mocked(mocks.prisma.task.update).mock.calls[0]?.[0];
    expect(typeof update?.data?.boardPosition).toBe('string');
    expect((update?.data?.boardPosition as string).length).toBeGreaterThan(0);
  });
});

describe('TasksService.update — hierarchy walker', () => {
  let mocks: Mocks;
  let service: TasksService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  function stubMe(overrides: Record<string, unknown> = {}) {
    vi.mocked(mocks.prisma.task.findUniqueOrThrow).mockResolvedValueOnce({
      id: 't-self',
      projectId: 'p1',
      type: 'Task',
      parentTaskId: null,
      assigneeUserId: null,
      createdById: 'actor-1',
      reporterUserId: 'actor-1',
      ...overrides,
    } as never);
  }

  it('rejects re-parenting that creates a cycle (self appears as ancestor)', async () => {
    stubMe();
    // 1st findUnique = the proposed parent. 2nd+ = the ancestor walk.
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p1', type: 'Story',
    } as never);
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 'parent-x', parentTaskId: 't-self', type: 'Story',
    } as never);
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-self', parentTaskId: null, type: 'Task',
    } as never);

    await expect(
      service.update(buildActor(), 't-self', { parentTaskId: 'parent-x' }),
    ).rejects.toThrow(/cycle/i);
  });

  it('rejects re-parenting under a chain that contains a Subtask anywhere', async () => {
    // Immediate parent (Story) is fine, but its parent is a Subtask — only
    // the walker catches it; the immediate-parent check by itself would not.
    stubMe();
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p1', type: 'Story',
    } as never);
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 'parent-x', parentTaskId: 'grand-x', type: 'Story',
    } as never);
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 'grand-x', parentTaskId: null, type: 'Subtask',
    } as never);

    await expect(
      service.update(buildActor(), 't-self', { parentTaskId: 'parent-x' }),
    ).rejects.toThrow(/Subtask/i);
  });

  it('refuses to demote to Subtask when the task has children', async () => {
    stubMe({ type: 'Story' });
    vi.mocked(mocks.prisma.task.count).mockResolvedValueOnce(3 as never);

    await expect(
      service.update(buildActor(), 't-self', { type: 'Subtask' }),
    ).rejects.toThrow(/child task/i);
  });
});

describe('TasksService.update — watcher-delete swallow contract', () => {
  let mocks: Mocks;
  let service: TasksService;

  beforeEach(() => {
    ({ service, mocks } = build());
    // prev assignee must NOT be creator/reporter, or the swallow branch isn't entered.
    vi.mocked(mocks.prisma.task.findUniqueOrThrow).mockResolvedValueOnce({
      id: 't-1', projectId: 'p1', type: 'Task', parentTaskId: null,
      assigneeUserId: 'prev-user', createdById: 'actor-1', reporterUserId: 'actor-1',
    } as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValueOnce({
      id: 't-1', assigneeUserId: 'new-user',
    } as never);
    vi.mocked(mocks.prisma.taskWatcher.upsert).mockResolvedValueOnce({} as never);
  });

  it('silently swallows P2025 (row already gone) from the prev-assignee unwatch', async () => {
    vi.mocked(mocks.prisma.taskWatcher.delete).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('row not found', { code: 'P2025', clientVersion: 'test' }),
    );
    await expect(
      service.update(buildActor(), 't-1', { assigneeUserId: 'new-user' }),
    ).resolves.toBeTruthy();
  });

  it('logs (does not throw) on non-P2025 Prisma errors — task.updated still fires', async () => {
    vi.mocked(mocks.prisma.taskWatcher.delete).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('connection lost', { code: 'P1001', clientVersion: 'test' }),
    );
    await expect(
      service.update(buildActor(), 't-1', { assigneeUserId: 'new-user' }),
    ).resolves.toBeTruthy();
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'task.updated', expect.objectContaining({ taskId: 't-1' }),
    );
  });
});
