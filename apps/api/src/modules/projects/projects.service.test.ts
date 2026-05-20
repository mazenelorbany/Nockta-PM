import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthService } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/types';

import { ProjectsService } from './projects.service';

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
  auth: {
    sendProjectInvite: ReturnType<typeof vi.fn>;
    requestMagicLink: ReturnType<typeof vi.fn>;
  };
  workflow: {
    seedDefaults: ReturnType<typeof vi.fn>;
  };
}

function build(): { service: ProjectsService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = {
    assertAtLeast: vi.fn().mockResolvedValue('Manager'),
    effectiveRole: vi.fn(),
    canSeeTask: vi.fn(),
  };
  const events = makeEventsMock();
  const auth = {
    sendProjectInvite: vi.fn().mockResolvedValue(undefined),
    requestMagicLink: vi.fn().mockResolvedValue(undefined),
  };
  // The workflow service is exercised by its own tests + the integration
  // path; here we just stub `seedDefaults` because every create() call hits
  // it. snapshot/createColumn/etc. aren't reached by these tests.
  const workflow = {
    seedDefaults: vi.fn().mockResolvedValue(undefined),
  };
  const service = new ProjectsService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
    auth as unknown as AuthService,
    workflow as unknown as import('./project-workflow.service').ProjectWorkflowService,
  );
  return { service, mocks: { prisma, permissions, events, auth, workflow } };
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

// =============================================================================
// inviteGuest — project-scoped invitation that combines user-create,
// project-access-grant, and magic-link email in one call.
// =============================================================================

describe('ProjectsService.inviteGuest', () => {
  let built: ReturnType<typeof build>;
  let service: ProjectsService;
  beforeEach(() => {
    built = build();
    service = built.service;
    vi.mocked(built.mocks.prisma.project.findUnique).mockResolvedValue({
      id: 'p-1',
      name: 'Acme Redesign',
      key: 'ACM',
    } as never);
    vi.mocked(built.mocks.prisma.user.findUnique).mockImplementation(
      // The service queries user.findUnique TWICE: once for the actor
      // (id-lookup, returns the admin row) and once for the recipient
      // (email-lookup, returns null for new invitees, an existing row
      // for re-invites). Switch on the `where` shape.
      ((args: { where: { id?: string; email?: string } }) => {
        if (args.where.id === ADMIN.id) {
          return Promise.resolve({ id: ADMIN.id, name: 'Admin Alice', email: ADMIN.email });
        }
        return Promise.resolve(null);
      }) as never,
    );
    vi.mocked(built.mocks.prisma.user.upsert).mockResolvedValue({ id: 'u-new' } as never);
    vi.mocked(built.mocks.prisma.projectAccess.upsert).mockResolvedValue({
      id: 'pa-new',
    } as never);
  });

  it('creates a guest, grants project access, sends invite, emits event', async () => {
    const result = await service.inviteGuest(ADMIN, 'p-1', {
      email: 'bob@external.test',
      name: 'Bob Builder',
      role: 'Contributor',
    });

    expect(built.mocks.permissions.assertAtLeast).toHaveBeenCalledWith(ADMIN, 'p-1', 'Manager');
    expect(built.mocks.prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'bob@external.test' },
        create: expect.objectContaining({
          email: 'bob@external.test',
          name: 'Bob Builder',
          kind: 'client',
          companyRole: null,
        }),
      }),
    );
    expect(built.mocks.prisma.projectAccess.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId_userId: { projectId: 'p-1', userId: 'u-new' } },
        create: expect.objectContaining({
          projectId: 'p-1',
          subjectKind: 'user',
          userId: 'u-new',
          role: 'Contributor',
        }),
        update: expect.objectContaining({ role: 'Contributor' }),
      }),
    );
    expect(built.mocks.auth.sendProjectInvite).toHaveBeenCalledWith({
      email: 'bob@external.test',
      projectId: 'p-1',
      projectName: 'Acme Redesign',
      inviterUserId: ADMIN.id,
      inviterName: 'Admin Alice',
      role: 'Contributor',
    });
    expect(built.mocks.events.emit).toHaveBeenCalledWith(
      'project.guest_invited',
      expect.objectContaining({
        projectId: 'p-1',
        userId: 'u-new',
        role: 'Contributor',
        actorUserId: ADMIN.id,
      }),
    );
    expect(result).toMatchObject({
      userId: 'u-new',
      email: 'bob@external.test',
      projectId: 'p-1',
      role: 'Contributor',
    });
  });

  it('rejects @nockta.com domain emails (internal users use Google OAuth)', async () => {
    await expect(
      service.inviteGuest(ADMIN, 'p-1', {
        email: 'someone@nockta.com',
        role: 'Contributor',
      }),
    ).rejects.toThrow(BadRequestException);
    // Permission check still happens (it's the first guard) but no writes.
    expect(built.mocks.prisma.projectAccess.upsert).not.toHaveBeenCalled();
    expect(built.mocks.auth.sendProjectInvite).not.toHaveBeenCalled();
  });

  it('refuses to re-invite an existing INTERNAL user as a guest', async () => {
    vi.mocked(built.mocks.prisma.user.findUnique).mockImplementation(
      ((args: { where: { id?: string; email?: string } }) => {
        if (args.where.id === ADMIN.id) {
          return Promise.resolve({ id: ADMIN.id, name: 'Admin', email: ADMIN.email });
        }
        return Promise.resolve({ id: 'u-existing', kind: 'internal' });
      }) as never,
    );

    await expect(
      service.inviteGuest(ADMIN, 'p-1', {
        email: 'staff@external.test',
        role: 'Viewer',
      }),
    ).rejects.toThrow(/already an internal user/);
    expect(built.mocks.auth.sendProjectInvite).not.toHaveBeenCalled();
  });

  it('is idempotent: re-invite reuses the user and updates role if changed', async () => {
    vi.mocked(built.mocks.prisma.user.findUnique).mockImplementation(
      ((args: { where: { id?: string; email?: string } }) => {
        if (args.where.id === ADMIN.id) {
          return Promise.resolve({ id: ADMIN.id, name: 'Admin', email: ADMIN.email });
        }
        return Promise.resolve({ id: 'u-existing', kind: 'client' });
      }) as never,
    );
    vi.mocked(built.mocks.prisma.user.upsert).mockResolvedValue({ id: 'u-existing' } as never);
    // Returning a stable id from upsert so the test can assert it bubbles
    // out as `grantId`. With Prisma upsert we no longer get a distinct
    // findFirst step; the update path is selected by the unique-where
    // clause when the row already exists.
    vi.mocked(built.mocks.prisma.projectAccess.upsert).mockResolvedValue({
      id: 'pa-old',
    } as never);

    const result = await service.inviteGuest(ADMIN, 'p-1', {
      email: 'bob@external.test',
      role: 'Contributor', // upgraded from Viewer
    });

    // upsert was called with the role update payload — Prisma decides
    // create-vs-update from the where clause hitting (or not hitting)
    // the unique index.
    expect(built.mocks.prisma.projectAccess.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId_userId: { projectId: 'p-1', userId: 'u-existing' } },
        update: expect.objectContaining({ role: 'Contributor' }),
      }),
    );
    // Email is re-sent (so the guest can find the link again).
    expect(built.mocks.auth.sendProjectInvite).toHaveBeenCalledOnce();
    expect(result.grantId).toBe('pa-old');
  });

  it('falls back to actor.email when actor.name is empty in the invitation', async () => {
    vi.mocked(built.mocks.prisma.user.findUnique).mockImplementation(
      ((args: { where: { id?: string; email?: string } }) => {
        if (args.where.id === ADMIN.id) {
          return Promise.resolve({ id: ADMIN.id, name: '', email: 'admin@nockta.com' });
        }
        return Promise.resolve(null);
      }) as never,
    );

    await service.inviteGuest(ADMIN, 'p-1', {
      email: 'guest@external.test',
      role: 'Viewer',
    });
    expect(built.mocks.auth.sendProjectInvite).toHaveBeenCalledWith(
      expect.objectContaining({ inviterName: 'admin@nockta.com' }),
    );
  });
});
