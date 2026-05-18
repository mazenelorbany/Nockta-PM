import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { TaskTemplatesService } from './task-templates.service';

// =============================================================================
// task-templates.service — focused tests on the new cross-project gallery
// behaviour (Sprint Lift). The existing CRUD methods are exercised by E2E.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: {
    assertAtLeast: ReturnType<typeof vi.fn>;
    effectiveRole: ReturnType<typeof vi.fn>;
  };
}

function build(): { service: TaskTemplatesService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = {
    assertAtLeast: vi.fn().mockResolvedValue('Manager'),
    effectiveRole: vi.fn().mockResolvedValue('Manager'),
  };
  const service = new TaskTemplatesService(prisma, permissions as unknown as PermissionsService);
  return { service, mocks: { prisma, permissions } };
}

const ADMIN: AuthenticatedUser = {
  id: 'u-admin',
  email: 'admin@nockta.com',
  kind: 'internal',
  companyRole: 'Admin',
} as AuthenticatedUser;

const MEMBER: AuthenticatedUser = {
  id: 'u-mem',
  email: 'm@nockta.com',
  kind: 'internal',
  companyRole: 'Member',
} as AuthenticatedUser;

describe('TaskTemplatesService.listGallery — cross-project visibility', () => {
  let mocks: Mocks;
  let service: TaskTemplatesService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('Admin sees templates from every non-archived project', async () => {
    // Admins skip the grant-scan. We assert that the controlling Prisma
    // call is `project.findMany({ where: { archivedAt: null } })`.
    vi.mocked(mocks.prisma.project.findMany).mockResolvedValueOnce([
      { id: 'p1' }, { id: 'p2' },
    ] as never);
    vi.mocked(
      (mocks.prisma as unknown as { taskTemplate: { findMany: ReturnType<typeof vi.fn> } })
        .taskTemplate.findMany,
    ).mockResolvedValueOnce([
      { id: 't1', projectId: 'p1', name: 'Bug', tags: ['support'], taskType: 'Bug' },
      { id: 't2', projectId: 'p2', name: 'Story', tags: ['frontend'], taskType: 'Story' },
    ] as never);

    const out = await service.listGallery(ADMIN);

    expect(out.length).toBe(2);
    const projectFindCall = vi.mocked(mocks.prisma.project.findMany).mock.calls[0]?.[0];
    expect(projectFindCall?.where).toEqual({ archivedAt: null });
  });

  it('Member only sees templates from projects they have access to (user / team / public)', async () => {
    vi.mocked(
      (mocks.prisma as unknown as { teamMember: { findMany: ReturnType<typeof vi.fn> } })
        .teamMember.findMany,
    ).mockResolvedValueOnce([{ teamId: 'team-1' }] as never);
    vi.mocked(mocks.prisma.project.findMany).mockResolvedValueOnce([
      { id: 'p1' }, { id: 'p3' },
    ] as never);
    vi.mocked(
      (mocks.prisma as unknown as { taskTemplate: { findMany: ReturnType<typeof vi.fn> } })
        .taskTemplate.findMany,
    ).mockResolvedValueOnce([
      { id: 't1', projectId: 'p1', name: 'Tpl', tags: [], taskType: null },
    ] as never);

    const out = await service.listGallery(MEMBER);

    expect(out.length).toBe(1);
    const projectFindCall = vi.mocked(mocks.prisma.project.findMany).mock.calls[0]?.[0];
    // OR clause must include user, team, and public branches.
    const orArr: unknown[] = projectFindCall?.where?.OR ?? [];
    expect(orArr.length).toBe(3);
  });

  it('returns [] for a user with zero accessible projects (no template query is issued)', async () => {
    vi.mocked(
      (mocks.prisma as unknown as { teamMember: { findMany: ReturnType<typeof vi.fn> } })
        .teamMember.findMany,
    ).mockResolvedValueOnce([] as never);
    vi.mocked(mocks.prisma.project.findMany).mockResolvedValueOnce([] as never);

    const out = await service.listGallery(MEMBER);

    expect(out).toEqual([]);
    expect(
      (mocks.prisma as unknown as { taskTemplate: { findMany: ReturnType<typeof vi.fn> } })
        .taskTemplate.findMany,
    ).not.toHaveBeenCalled();
  });

  it('type filter: untyped templates (taskType=null) appear alongside the requested type', async () => {
    // We can't fully validate the where clause from the outside (Prisma JSON
    // is opaque), so the test asserts the SHAPE that goes through.
    vi.mocked(mocks.prisma.project.findMany).mockResolvedValueOnce([{ id: 'p1' }] as never);
    vi.mocked(
      (mocks.prisma as unknown as { taskTemplate: { findMany: ReturnType<typeof vi.fn> } })
        .taskTemplate.findMany,
    ).mockResolvedValueOnce([] as never);

    await service.listGallery(ADMIN, { type: 'Bug' });

    const tplCall = vi.mocked(
      (mocks.prisma as unknown as { taskTemplate: { findMany: ReturnType<typeof vi.fn> } })
        .taskTemplate.findMany,
    ).mock.calls[0]?.[0];
    expect(tplCall?.where?.OR).toEqual([{ taskType: 'Bug' }, { taskType: null }]);
  });

  it('q filter: case-insensitive substring across name + description + titleTemplate', async () => {
    vi.mocked(mocks.prisma.project.findMany).mockResolvedValueOnce([{ id: 'p1' }] as never);
    vi.mocked(
      (mocks.prisma as unknown as { taskTemplate: { findMany: ReturnType<typeof vi.fn> } })
        .taskTemplate.findMany,
    ).mockResolvedValueOnce([
      { id: 't1', name: 'Postmortem', description: '', titleTemplate: 'Incident retro', tags: [] },
      { id: 't2', name: 'Bug', description: 'Reported by a client', titleTemplate: 'Bug', tags: [] },
    ] as never);

    const out = await service.listGallery(ADMIN, { q: 'INCIDENT' });

    expect(out.map((t) => t.id)).toEqual(['t1']);
  });

  it('tag filter passes through to the Prisma `has` clause normalised to lowercase', async () => {
    vi.mocked(mocks.prisma.project.findMany).mockResolvedValueOnce([{ id: 'p1' }] as never);
    vi.mocked(
      (mocks.prisma as unknown as { taskTemplate: { findMany: ReturnType<typeof vi.fn> } })
        .taskTemplate.findMany,
    ).mockResolvedValueOnce([] as never);

    await service.listGallery(ADMIN, { tag: '  Engineering  ' });

    const tplCall = vi.mocked(
      (mocks.prisma as unknown as { taskTemplate: { findMany: ReturnType<typeof vi.fn> } })
        .taskTemplate.findMany,
    ).mock.calls[0]?.[0];
    expect(tplCall?.where?.tags).toEqual({ has: 'engineering' });
  });
});

describe('TaskTemplatesService.instantiate — cross-project destination', () => {
  let mocks: Mocks;
  let service: TaskTemplatesService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('uses targetProjectId for both the permission check and the destination project lookup', async () => {
    vi.mocked(
      (mocks.prisma as unknown as { taskTemplate: { findUnique: ReturnType<typeof vi.fn> } })
        .taskTemplate.findUnique,
    ).mockResolvedValueOnce({
      id: 't1',
      projectId: 'p-source',
      name: 'Bug',
      titleTemplate: 'Reported bug',
      bodyTemplate: null,
      priority: 'Medium',
      estimate: null,
      defaultStatus: null,
      labelIds: ['lbl-source'], // Source-project label — must NOT be carried over
      tags: [],
      taskType: 'Bug',
    } as never);
    vi.mocked(mocks.prisma.project.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'p-dest', key: 'DST', workflowPreset: 'engineering',
    } as never);
    vi.mocked(mocks.prisma.task.findFirst).mockResolvedValueOnce(null as never);
    vi.mocked(mocks.prisma.project.update).mockResolvedValueOnce({ nextTaskNumber: 5 } as never);
    vi.mocked(mocks.prisma.task.create).mockResolvedValueOnce({
      id: 'new-task', keyNumber: 4, projectId: 'p-dest',
    } as never);

    await service.instantiate(MEMBER, 't1', { targetProjectId: 'p-dest' });

    // Two assertAtLeast calls — Viewer on source, Contributor on destination.
    expect(mocks.permissions.assertAtLeast).toHaveBeenCalledWith(MEMBER, 'p-source', 'Viewer');
    expect(mocks.permissions.assertAtLeast).toHaveBeenCalledWith(MEMBER, 'p-dest', 'Contributor');

    // Destination lookup uses p-dest, not p-source.
    const projCall = vi.mocked(mocks.prisma.project.findUniqueOrThrow).mock.calls[0]?.[0];
    expect(projCall?.where?.id).toBe('p-dest');

    // Labels dropped on cross-project.
    const taskCreateCall = vi.mocked(mocks.prisma.task.create).mock.calls[0]?.[0];
    expect(taskCreateCall?.data?.labels).toBeUndefined();
    // Task type propagates from template.
    expect(taskCreateCall?.data?.type).toBe('Bug');
  });

  it('rejects when actor has no Contributor on the destination project', async () => {
    vi.mocked(
      (mocks.prisma as unknown as { taskTemplate: { findUnique: ReturnType<typeof vi.fn> } })
        .taskTemplate.findUnique,
    ).mockResolvedValueOnce({
      id: 't1', projectId: 'p-source', name: 'Bug', titleTemplate: 'x',
      bodyTemplate: null, priority: 'Medium', estimate: null, defaultStatus: null,
      labelIds: [], tags: [], taskType: null,
    } as never);

    mocks.permissions.assertAtLeast
      .mockResolvedValueOnce('Viewer')            // source Viewer ok
      .mockRejectedValueOnce(new ForbiddenException('Need Contributor'));

    await expect(
      service.instantiate(MEMBER, 't1', { targetProjectId: 'p-dest' }),
    ).rejects.toThrow(ForbiddenException);
    expect(mocks.prisma.task.create).not.toHaveBeenCalled();
  });
});
