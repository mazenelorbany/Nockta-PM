import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';
import { DEFAULT_WORKSPACE_ID, WorkspaceContextService } from './workspace-context.service';

// =============================================================================
// WorkspaceService
//
// Multi-tenant authority surface. Companion to WorkspaceContextService
// (which is a read-mostly cache layer for "what's this user's workspace"):
// THIS service owns the WorkspaceMember table — listing members, adding,
// removing, role changes — plus the canonical assertMember() boundary check
// that every cross-tenant-sensitive endpoint funnels through.
//
// Why a separate service:
//   - WorkspaceContextService is hot-path and intentionally pure (no
//     writes). Mixing membership mutation logic into it would force every
//     controller that just needs to read the actor's workspace to depend
//     on the bigger surface.
//   - Tests for membership mutation want to drive Prisma writes directly;
//     keeping them out of the cache layer keeps that test surface narrow.
//
// Authorisation model:
//   - Owner  > Admin > Member.
//   - Adding/removing/role-changing requires Admin OR Owner.
//   - Listing members requires Member-or-better in that workspace.
//   - The brief explicitly does NOT introduce Postgres RLS — every cross-
//     workspace boundary is service-layer-only. assertMember() is the
//     single chokepoint; callers MUST call it before touching any
//     workspace-scoped resource on behalf of an actor.
// =============================================================================

/** Membership tiers, in increasing privilege. The string vs enum choice
 *  matches the Prisma schema column (TEXT). Validated everywhere via
 *  WORKSPACE_ROLES. */
export const WORKSPACE_ROLES = ['Owner', 'Admin', 'Member'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Roles that can mutate membership (add/remove/role change). Owner is a
 *  superset — there's always at least one Owner per workspace, enforced by
 *  removeMember refusing to drop the last Owner. */
const ADMIN_ROLES: ReadonlySet<WorkspaceRole> = new Set(['Owner', 'Admin']);

export interface WorkspaceMemberRow {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: Date;
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    kind: 'internal' | 'client';
    companyRole: 'Admin' | 'Member' | null;
  };
}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceCtx: WorkspaceContextService,
  ) {}

  /**
   * Resolve the actor's "current" workspace. For now this is the first
   * WorkspaceMember row owned by the user (ordered by createdAt asc,
   * ties broken by workspaceId). When the actor has zero memberships we
   * fall back to the bootstrap 'default' workspace so the legacy
   * single-tenant path doesn't 500 — but this fallback emits a warn so
   * the gap is visible in logs.
   */
  async getCurrent(actor: AuthenticatedUser): Promise<{
    id: string;
    name: string;
    slug: string;
    role: WorkspaceRole;
  }> {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: { userId: actor.id },
      orderBy: [{ createdAt: 'asc' }, { workspaceId: 'asc' }],
      include: { workspace: true },
    });
    if (membership) {
      return {
        id: membership.workspaceId,
        name: membership.workspace.name,
        slug: membership.workspace.slug,
        role: membership.role as WorkspaceRole,
      };
    }
    this.logger.warn(
      { userId: actor.id },
      'workspace.getCurrent: actor has no WorkspaceMember row; falling back to default',
    );
    const defaultWs = await this.prisma.workspace.findUnique({
      where: { id: DEFAULT_WORKSPACE_ID },
    });
    if (!defaultWs) {
      throw new NotFoundException('Bootstrap workspace missing — run migrations');
    }
    return {
      id: defaultWs.id,
      name: defaultWs.name,
      slug: defaultWs.slug,
      role: 'Member',
    };
  }

  /**
   * Throw 403 if the actor isn't a member of the given workspace.
   * Returns the WorkspaceMember row when authorised. Every workspace-scoped
   * controller funnels through this — there is no other gate.
   *
   * Defensive fallback: when the workspaceId IS the bootstrap 'default' AND
   * the actor has no membership row at all, we treat it as an implicit
   * Member (companyRole 'Admin' becomes 'Admin'). This preserves the
   * pre-migration single-tenant behaviour for legacy users whose backfill
   * row was rolled back or never created. New deployments that actively
   * insert non-default workspaces won't trip this branch.
   */
  async assertMember(
    workspaceId: string,
    actor: AuthenticatedUser,
  ): Promise<{ workspaceId: string; userId: string; role: WorkspaceRole }> {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: actor.id } },
    });
    if (membership) {
      return {
        workspaceId: membership.workspaceId,
        userId: membership.userId,
        role: membership.role as WorkspaceRole,
      };
    }
    if (workspaceId === DEFAULT_WORKSPACE_ID) {
      // Implicit-member fallback for legacy callers — see method docstring.
      const role: WorkspaceRole = actor.companyRole === 'Admin' ? 'Admin' : 'Member';
      return { workspaceId, userId: actor.id, role };
    }
    throw new ForbiddenException('Not a member of this workspace');
  }

  /** Convenience — throws unless the actor's role is Admin or Owner. */
  async assertAdmin(workspaceId: string, actor: AuthenticatedUser): Promise<void> {
    const m = await this.assertMember(workspaceId, actor);
    if (!ADMIN_ROLES.has(m.role)) {
      throw new ForbiddenException('Workspace Admin or Owner required');
    }
  }

  /** List members in a workspace. Actor must be a member of `workspaceId`. */
  async listMembers(
    workspaceId: string,
    actor: AuthenticatedUser,
  ): Promise<WorkspaceMemberRow[]> {
    await this.assertMember(workspaceId, actor);
    const rows = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            avatarUrl: true,
            kind: true,
            companyRole: true,
          },
        },
      },
    });
    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      userId: r.userId,
      role: r.role as WorkspaceRole,
      createdAt: r.createdAt,
      user: r.user,
    }));
  }

  /**
   * Add a member to a workspace. Idempotent — re-adding an existing
   * (workspaceId, userId) pair with the same role is a no-op; with a
   * different role it updates the role.
   */
  async addMember(
    workspaceId: string,
    actor: AuthenticatedUser,
    input: { userId: string; role: WorkspaceRole },
  ): Promise<WorkspaceMemberRow> {
    await this.assertAdmin(workspaceId, actor);
    this.validateRole(input.role);

    // Verify the user exists — otherwise the FK throws a less helpful error.
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        kind: true,
        companyRole: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const row = await this.prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId: input.userId } },
      update: { role: input.role },
      create: { workspaceId, userId: input.userId, role: input.role },
    });
    // Invalidate the per-user workspace cache so the new membership shows
    // up on the next request without waiting out the 60s TTL.
    this.workspaceCtx.invalidate(input.userId);
    return {
      workspaceId: row.workspaceId,
      userId: row.userId,
      role: row.role as WorkspaceRole,
      createdAt: row.createdAt,
      user,
    };
  }

  /** Update an existing member's role. Same auth gate as addMember. */
  async updateRole(
    workspaceId: string,
    actor: AuthenticatedUser,
    input: { userId: string; role: WorkspaceRole },
  ): Promise<WorkspaceMemberRow> {
    await this.assertAdmin(workspaceId, actor);
    this.validateRole(input.role);

    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: input.userId } },
    });
    if (!existing) throw new NotFoundException('Membership not found');

    // Demoting the last Owner would leave the workspace ownerless. Refuse.
    if (existing.role === 'Owner' && input.role !== 'Owner') {
      const ownerCount = await this.prisma.workspaceMember.count({
        where: { workspaceId, role: 'Owner' },
      });
      if (ownerCount <= 1) {
        throw new BadRequestException(
          'Cannot demote the last Owner — promote another member to Owner first',
        );
      }
    }

    const updated = await this.prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: input.userId } },
      data: { role: input.role },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            avatarUrl: true,
            kind: true,
            companyRole: true,
          },
        },
      },
    });
    this.workspaceCtx.invalidate(input.userId);
    return {
      workspaceId: updated.workspaceId,
      userId: updated.userId,
      role: updated.role as WorkspaceRole,
      createdAt: updated.createdAt,
      user: updated.user,
    };
  }

  /**
   * Remove a member. Refuses to drop the last Owner. Idempotent for
   * already-removed rows (returns `{ removed: false }` in that case so
   * the caller can distinguish).
   */
  async removeMember(
    workspaceId: string,
    actor: AuthenticatedUser,
    userId: string,
  ): Promise<{ removed: boolean }> {
    await this.assertAdmin(workspaceId, actor);

    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!existing) return { removed: false };

    if (existing.role === 'Owner') {
      const ownerCount = await this.prisma.workspaceMember.count({
        where: { workspaceId, role: 'Owner' },
      });
      if (ownerCount <= 1) {
        throw new BadRequestException(
          'Cannot remove the last Owner — promote another member to Owner first',
        );
      }
    }

    try {
      await this.prisma.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return { removed: false };
      }
      throw err;
    }
    this.workspaceCtx.invalidate(userId);
    return { removed: true };
  }

  // -------------------------------------------------------------- helpers

  private validateRole(role: WorkspaceRole): void {
    if (!WORKSPACE_ROLES.includes(role)) {
      throw new BadRequestException(
        `role must be one of ${WORKSPACE_ROLES.join(', ')}`,
      );
    }
  }
}
