import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';
import { WorkspaceContextService } from './workspace-context.service';
import { WorkspaceService } from './workspace.service';

// =============================================================================
// workspace.service — the multi-tenant boundary contract.
//
// Tests anchor the four behaviors the brief calls out explicitly:
//   1. assertMember throws 403 for non-members, returns the membership row
//      otherwise.
//   2. addMember is idempotent — re-adding the same (workspace, user) pair
//      with the same role is a no-op; different role -> role update.
//   3. updateRole rejects when the actor isn't Admin/Owner.
//   4. Cross-workspace isolation — an Admin in workspace A cannot list
//      members of workspace B.
// =============================================================================

function actor(over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'u-1',
    email: 'u1@nockta.com',
    kind: 'internal',
    companyRole: 'Member',
    jti: 'j-1',
    workspaceId: 'ws-A',
    ...over,
  };
}

function build(): { svc: WorkspaceService; prisma: PrismaService } {
  const prisma = makePrismaMock();
  // WorkspaceContextService isn't itself under test here — its invalidate()
  // is called by mutating paths. A bare stub is enough; we don't want a
  // real Prisma round-trip for the cache.
  const ctx = new WorkspaceContextService(prisma);
  vi.spyOn(ctx, 'invalidate').mockImplementation(() => undefined);
  const svc = new WorkspaceService(prisma, ctx);
  return { svc, prisma };
}

// ---------------------------------------------------------------------------
// assertMember
// ---------------------------------------------------------------------------

describe('WorkspaceService.assertMember', () => {
  let svc: WorkspaceService;
  let prisma: PrismaService;
  beforeEach(() => {
    ({ svc, prisma } = build());
  });

  it('returns the membership row when the actor is a member', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Admin',
      createdAt: new Date(),
    } as never);

    const out = await svc.assertMember('ws-A', actor());
    expect(out).toEqual({ workspaceId: 'ws-A', userId: 'u-1', role: 'Admin' });
  });

  it('throws ForbiddenException for non-members of a non-default workspace', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce(null as never);

    await expect(svc.assertMember('ws-B', actor())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('falls back to implicit Member for legacy callers on the default workspace', async () => {
    // No row at all — but workspaceId is 'default'. We treat this as the
    // pre-migration single-tenant path and let the call through with a
    // role derived from companyRole.
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce(null as never);

    const out = await svc.assertMember('default', actor({ companyRole: 'Admin' }));
    expect(out.role).toBe('Admin');
  });

  it('legacy fallback maps non-Admin companyRole to Member, not Admin', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce(null as never);
    const out = await svc.assertMember('default', actor({ companyRole: 'Member' }));
    expect(out.role).toBe('Member');
  });
});

// ---------------------------------------------------------------------------
// assertAdmin
// ---------------------------------------------------------------------------

describe('WorkspaceService.assertAdmin', () => {
  let svc: WorkspaceService;
  let prisma: PrismaService;
  beforeEach(() => {
    ({ svc, prisma } = build());
  });

  it('passes for Owner', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Owner',
    } as never);
    await expect(svc.assertAdmin('ws-A', actor())).resolves.toBeUndefined();
  });

  it('passes for Admin', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Admin',
    } as never);
    await expect(svc.assertAdmin('ws-A', actor())).resolves.toBeUndefined();
  });

  it('rejects Member', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Member',
    } as never);
    await expect(svc.assertAdmin('ws-A', actor())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

// ---------------------------------------------------------------------------
// addMember idempotency
// ---------------------------------------------------------------------------

describe('WorkspaceService.addMember', () => {
  let svc: WorkspaceService;
  let prisma: PrismaService;
  beforeEach(() => {
    ({ svc, prisma } = build());
  });

  it('upserts so re-adding the same (workspace, user) is idempotent', async () => {
    // Auth gate: actor is Admin of ws-A.
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Admin',
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u-2',
      email: 'u2@nockta.com',
      name: 'U2',
      avatarUrl: null,
      kind: 'internal',
      companyRole: 'Member',
    } as never);
    vi.mocked(prisma.workspaceMember.upsert).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-2',
      role: 'Member',
      createdAt: new Date(),
    } as never);

    await svc.addMember('ws-A', actor(), { userId: 'u-2', role: 'Member' });

    const call = vi.mocked(prisma.workspaceMember.upsert).mock.calls[0]?.[0];
    expect(call?.where).toEqual({
      workspaceId_userId: { workspaceId: 'ws-A', userId: 'u-2' },
    });
    expect(call?.update).toEqual({ role: 'Member' });
    expect(call?.create).toEqual({ workspaceId: 'ws-A', userId: 'u-2', role: 'Member' });
  });

  it('rejects a non-Admin caller with ForbiddenException', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Member',
    } as never);

    await expect(
      svc.addMember('ws-A', actor(), { userId: 'u-2', role: 'Member' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMember.upsert).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for a missing user', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Admin',
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null as never);

    await expect(
      svc.addMember('ws-A', actor(), { userId: 'missing', role: 'Member' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// updateRole
// ---------------------------------------------------------------------------

describe('WorkspaceService.updateRole', () => {
  let svc: WorkspaceService;
  let prisma: PrismaService;
  beforeEach(() => {
    ({ svc, prisma } = build());
  });

  it('rejects when the actor is a Member (not Admin/Owner)', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Member',
    } as never);

    await expect(
      svc.updateRole('ws-A', actor(), { userId: 'u-2', role: 'Admin' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
  });

  it('refuses to demote the last Owner', async () => {
    // Auth gate
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Owner',
    } as never);
    // Target lookup
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Owner',
    } as never);
    vi.mocked(prisma.workspaceMember.count).mockResolvedValueOnce(1 as never);

    await expect(
      svc.updateRole('ws-A', actor(), { userId: 'u-1', role: 'Member' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets an Admin promote a Member to Admin', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Admin',
    } as never);
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-2',
      role: 'Member',
    } as never);
    vi.mocked(prisma.workspaceMember.update).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-2',
      role: 'Admin',
      createdAt: new Date(),
      user: {
        id: 'u-2',
        email: 'u2@nockta.com',
        name: 'U2',
        avatarUrl: null,
        kind: 'internal',
        companyRole: 'Member',
      },
    } as never);

    const out = await svc.updateRole('ws-A', actor(), { userId: 'u-2', role: 'Admin' });
    expect(out.role).toBe('Admin');
  });
});

// ---------------------------------------------------------------------------
// Cross-workspace isolation — listMembers
// ---------------------------------------------------------------------------

describe('Cross-workspace isolation', () => {
  let svc: WorkspaceService;
  let prisma: PrismaService;
  beforeEach(() => {
    ({ svc, prisma } = build());
  });

  it('refuses to list members of a workspace the actor is not a member of', async () => {
    // The actor is an Admin in ws-A; they cannot peek into ws-B.
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce(null as never);

    await expect(svc.listMembers('ws-B', actor())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.workspaceMember.findMany).not.toHaveBeenCalled();
  });

  it('returns the member list when the actor IS a member of the target workspace', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValueOnce({
      workspaceId: 'ws-A',
      userId: 'u-1',
      role: 'Admin',
    } as never);
    vi.mocked(prisma.workspaceMember.findMany).mockResolvedValueOnce([
      {
        workspaceId: 'ws-A',
        userId: 'u-1',
        role: 'Admin',
        createdAt: new Date(),
        user: {
          id: 'u-1',
          email: 'u1@nockta.com',
          name: 'U1',
          avatarUrl: null,
          kind: 'internal',
          companyRole: 'Admin',
        },
      },
    ] as never);

    const rows = await svc.listMembers('ws-A', actor());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe('u-1');
  });
});
