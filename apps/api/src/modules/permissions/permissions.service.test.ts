import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makePrismaMock } from '../../test-utils/mocks';
import type { AuthenticatedUser } from '../auth/types';
import type { PrismaService } from '../../prisma/prisma.service';

import { PermissionsService } from './permissions.service';

// =============================================================================
// permissions.service — the gate every other service consults. Each branch
// here directly maps to a security claim we make in the spec:
//
//   - Admins bypass everything ("Admins see every project as Manager").
//   - Direct user grants override default visibility.
//   - Team grants roll up; the highest role across user + team grants wins.
//   - Public projects default internal members to Viewer.
//   - Clients are NEVER on teams; team grants don't apply to them.
//   - canSeeTask honors per-task and per-project visibility correctly.
//
// effectiveRole was refactored to a single projectAccess.findMany covering
// both user + team grants (was N+1). The tests below stub findMany with the
// union of grants the user/team would have.
// =============================================================================

function buildUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'user-1',
    email: 'someone@nockta.com',
    kind: 'internal',
    companyRole: 'Member',
    ...overrides,
  } as AuthenticatedUser;
}

describe('PermissionsService.effectiveRole', () => {
  let prisma: PrismaService;
  let service: PermissionsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new PermissionsService(prisma);
  });

  it('returns Manager for an Admin without consulting grants', async () => {
    const role = await service.effectiveRole(
      buildUser({ companyRole: 'Admin' }),
      'project-1',
    );
    expect(role).toBe('Manager');
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
    expect(prisma.projectAccess.findMany).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the project does not exist', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.teamMember.findMany).mockResolvedValueOnce([]);
    await expect(
      service.effectiveRole(buildUser(), 'missing-project'),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns the direct user grant when one exists', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p',
      visibility: 'private',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.teamMember.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.projectAccess.findMany).mockResolvedValueOnce([
      { role: 'Contributor' },
    ] as never);

    const role = await service.effectiveRole(buildUser(), 'p');
    expect(role).toBe('Contributor');
  });

  it('takes the HIGHEST role across user grant + team grants', async () => {
    // A user with Viewer direct + Manager via team should end up Manager.
    // The refactored query returns both rows in one findMany; max() across
    // the result set is what picks the winner.
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p',
      visibility: 'private',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.teamMember.findMany).mockResolvedValueOnce([
      { teamId: 'team-1' },
    ] as never);
    vi.mocked(prisma.projectAccess.findMany).mockResolvedValueOnce([
      { role: 'Viewer' }, // direct user grant
      { role: 'Manager' }, // team grant
    ] as never);

    const role = await service.effectiveRole(buildUser(), 'p');
    expect(role).toBe('Manager');
  });

  it('falls back to Viewer when project is public and user has no grant', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p',
      visibility: 'public',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.teamMember.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.projectAccess.findMany).mockResolvedValueOnce([] as never);

    const role = await service.effectiveRole(buildUser(), 'p');
    expect(role).toBe('Viewer');
  });

  it('does NOT grant Viewer-via-public to clients', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p',
      visibility: 'public',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.projectAccess.findMany).mockResolvedValueOnce([] as never);

    const role = await service.effectiveRole(
      buildUser({ kind: 'client', companyRole: null }),
      'p',
    );
    expect(role).toBeNull();
  });

  it('skips team-grant lookup entirely for clients', async () => {
    // Clients aren't members of teams. The Promise.all branch in
    // effectiveRole short-circuits to an empty array without hitting Prisma.
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p',
      visibility: 'private',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.projectAccess.findMany).mockResolvedValueOnce([
      { role: 'Client' },
    ] as never);

    const role = await service.effectiveRole(
      buildUser({ kind: 'client', companyRole: null }),
      'p',
    );
    expect(role).toBe('Client');
    expect(prisma.teamMember.findMany).not.toHaveBeenCalled();
  });

  it('returns null when private project has no grants for the user', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p',
      visibility: 'private',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.teamMember.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.projectAccess.findMany).mockResolvedValueOnce([] as never);

    const role = await service.effectiveRole(buildUser(), 'p');
    expect(role).toBeNull();
  });
});

describe('PermissionsService.assertAtLeast', () => {
  let prisma: PrismaService;
  let service: PermissionsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new PermissionsService(prisma);
  });

  it('returns the role when it meets the minimum', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p',
      visibility: 'public',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.teamMember.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.projectAccess.findMany).mockResolvedValueOnce([
      { role: 'Manager' },
    ] as never);

    await expect(service.assertAtLeast(buildUser(), 'p', 'Contributor')).resolves.toBe(
      'Manager',
    );
  });

  it('throws ForbiddenException when role is below the minimum', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p',
      visibility: 'public',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.teamMember.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.projectAccess.findMany).mockResolvedValueOnce([
      { role: 'Viewer' },
    ] as never);

    await expect(
      service.assertAtLeast(buildUser(), 'p', 'Contributor'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when user has no role at all', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p',
      visibility: 'private',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.teamMember.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.projectAccess.findMany).mockResolvedValueOnce([] as never);

    await expect(service.assertAtLeast(buildUser(), 'p', 'Viewer')).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('PermissionsService.canSeeTask', () => {
  let prisma: PrismaService;
  let service: PermissionsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new PermissionsService(prisma);
  });

  function stubAccess(role: 'Manager' | 'Contributor' | 'Viewer' | 'Client') {
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p',
      visibility: 'private',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.teamMember.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.projectAccess.findMany).mockResolvedValueOnce([
      { role },
    ] as never);
  }

  it('returns false when user has no project access at all', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p',
      visibility: 'private',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.teamMember.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.projectAccess.findMany).mockResolvedValueOnce([] as never);

    expect(await service.canSeeTask(buildUser(), 'p', 'client_visible')).toBe(false);
  });

  it('allows internal members to see internal tasks', async () => {
    stubAccess('Contributor');
    expect(await service.canSeeTask(buildUser(), 'p', 'internal')).toBe(true);
  });

  it('blocks clients from seeing internal tasks by default', async () => {
    stubAccess('Client');
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      defaultTaskVisibility: 'internal',
    } as never);

    expect(
      await service.canSeeTask(
        buildUser({ kind: 'client', companyRole: null }),
        'p',
        'internal',
      ),
    ).toBe(false);
  });

  it('allows clients to see internal tasks when project is in Open sharing mode', async () => {
    stubAccess('Client');
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
      defaultTaskVisibility: 'client_visible',
    } as never);

    expect(
      await service.canSeeTask(
        buildUser({ kind: 'client', companyRole: null }),
        'p',
        'internal',
      ),
    ).toBe(true);
  });

  it('always shows client_visible tasks to clients (no fallback consulted)', async () => {
    stubAccess('Client');
    expect(
      await service.canSeeTask(
        buildUser({ kind: 'client', companyRole: null }),
        'p',
        'client_visible',
      ),
    ).toBe(true);
  });
});
