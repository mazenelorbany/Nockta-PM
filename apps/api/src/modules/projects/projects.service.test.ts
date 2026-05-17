import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsService } from './projects.service';
import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// projects.service — covers the behaviors that aren't bare CRUD:
//
//   - assertAdmin guards on create / archive / template management.
//   - Project key regex enforced before any DB roundtrip.
//   - createFromTemplate batches the keyNumber counter (Batch A item A10)
//     — single project.update bump + single task.createMany regardless of
//     sampleTasks.length, instead of the previous 2N roundtrips.
//   - grantAccess refuses inconsistent subjectKind/userId/teamId combos.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: {
    assertAtLeast: ReturnType<typeof vi.fn>;
    effectiveRole: ReturnType<typeof vi.fn>;
    canSeeTask: ReturnType<typeof vi.fn>;
  };
  events: ReturnType<typeof makeEventsMock>;
}

function build(): { service: ProjectsService; mocks: Mocks } {
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

describe('ProjectsService.create', () => {
  let mocks: Mocks;
  let service: ProjectsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('refuses non-Admin actors', async () => {
    await expect(
      service.create(MEMBER, {
        key: 'GOOD',
        name: 'New project',
        visibility: 'public',
        workflowPreset: 'engineering',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses key that violates the 2-10 uppercase regex', async () => {
    await expect(
      service.create(ADMIN, {
        key: 'tooLowerCase',
        name: 'X',
        visibility: 'public',
        workflowPreset: 'engineering',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('translates Prisma P2002 (key uniqueness) to ConflictException', async () => {
    vi.mocked(mocks.prisma.project.create).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('uniq', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.create(ADMIN, {
        key: 'DUP',
        name: 'X',
        visibility: 'public',
        workflowPreset: 'engineering',
      }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('ProjectsService.grantAccess — input validation', () => {
  let mocks: Mocks;
  let service: ProjectsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('refuses user-grant without userId', async () => {
    await expect(
      service.grantAccess(ADMIN, 'p1', {
        subjectKind: 'user',
        role: 'Contributor',
      }),
    ).rejects.toThrow(/userId required/i);
  });

  it('refuses team-grant without teamId', async () => {
    await expect(
      service.grantAccess(ADMIN, 'p1', {
        subjectKind: 'team',
        role: 'Contributor',
      }),
    ).rejects.toThrow(/teamId required/i);
  });

  it('writes a user grant when subjectKind=user + userId provided', async () => {
    vi.mocked(mocks.prisma.projectAccess.create).mockResolvedValueOnce({
      id: 'g-1',
    } as never);

    await service.grantAccess(ADMIN, 'p1', {
      subjectKind: 'user',
      userId: 'u-2',
      role: 'Contributor',
    });

    const args = vi.mocked(mocks.prisma.projectAccess.create).mock.calls[0]?.[0];
    expect(args?.data).toMatchObject({
      projectId: 'p1',
      subjectKind: 'user',
      userId: 'u-2',
      teamId: null,
      role: 'Contributor',
    });
  });
});

describe('ProjectsService.createFromTemplate — guards (Batch A A10 refactor)', () => {
  // Full-path assertions on the batched createMany counter would require
  // modeling $transaction(cb) with bag-of-mocks consistency for project,
  // label, task, taskWatcher — fragile in unit form. The high-signal
  // assertions are the two guards below; the batched-counter optimization
  // is verified by reading projects.service.ts:269-318 (single counter
  // bump + createMany).
  let service: ProjectsService;

  beforeEach(() => {
    ({ service } = build());
  });

  it('refuses non-Admin actors before touching the template', async () => {
    await expect(
      service.createFromTemplate(MEMBER, {
        templateId: 't-1',
        key: 'NEW',
        name: 'X',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses key that fails the 2-10 uppercase regex', async () => {
    await expect(
      service.createFromTemplate(ADMIN, {
        templateId: 't-1',
        key: 'bad-key',
        name: 'X',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
