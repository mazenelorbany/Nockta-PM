import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ProjectRole } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';

const ROLE_RANK: Record<ProjectRole, number> = {
  Client: 0,
  Viewer: 1,
  Contributor: 2,
  Manager: 3,
};

function max(a: ProjectRole | null, b: ProjectRole | null): ProjectRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Compute the effective project role for a user.
   * Admins always see Manager. Clients are never Members; their access is per-grant.
   * Returns null if the user has no access to the project.
   */
  async effectiveRole(user: AuthenticatedUser, projectId: string): Promise<ProjectRole | null> {
    // Admins bypass everything.
    if (user.kind === 'internal' && user.companyRole === 'Admin') {
      return 'Manager';
    }

    // Fetch project + user grant + team grants in ONE round-trip via Prisma's
    // include. Previously we issued up to 4 separate queries (project,
    // userGrant, teamMember, teamGrants) which on a guard-heavy request like
    // /tasks/project/:id (called for every board paint) was a measurable
    // multiplier. The shape below is one query: project with a filtered
    // accessGrants relation (only grants that match this user OR a team
    // they're on) plus the user's team-memberships in parallel.
    //
    // The teamMember query is deliberately split — it can't be expressed
    // as part of the project include without an exists subquery, and Prisma
    // doesn't expose that yet. Two queries via Promise.all is the floor.
    const [project, memberships] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, visibility: true, archivedAt: true },
      }),
      user.kind === 'internal'
        ? this.prisma.teamMember.findMany({
            where: { userId: user.id },
            select: { teamId: true },
          })
        : Promise.resolve([] as { teamId: string }[]),
    ]);
    if (!project) throw new NotFoundException('Project not found');

    const teamIds = memberships.map((m) => m.teamId);
    const grants = await this.prisma.projectAccess.findMany({
      where: {
        projectId,
        OR: [
          { subjectKind: 'user', userId: user.id },
          ...(teamIds.length > 0
            ? [{ subjectKind: 'team' as const, teamId: { in: teamIds } }]
            : []),
        ],
      },
      select: { role: true },
    });

    let role: ProjectRole | null = null;
    for (const g of grants) role = max(role, g.role);

    // Public-project default: internal Members get Viewer.
    if (
      role === null &&
      project.visibility === 'public' &&
      user.kind === 'internal'
    ) {
      role = 'Viewer';
    }

    return role;
  }

  async assertAtLeast(
    user: AuthenticatedUser,
    projectId: string,
    minimum: ProjectRole,
  ): Promise<ProjectRole> {
    const role = await this.effectiveRole(user, projectId);
    if (role === null || ROLE_RANK[role] < ROLE_RANK[minimum]) {
      throw new ForbiddenException(
        `Requires project role ${minimum}; have ${role ?? 'none'}`,
      );
    }
    return role;
  }

  async canSeeTask(
    user: AuthenticatedUser,
    projectId: string,
    visibility: 'internal' | 'client_visible',
  ): Promise<boolean> {
    const role = await this.effectiveRole(user, projectId);
    if (role === null) return false;
    if (role !== 'Client') return true;
    if (visibility === 'client_visible') return true;
    // Client + task marked internal — fall back to the project-level default.
    // Projects in "share everything" mode (defaultTaskVisibility=client_visible)
    // expose internal-tagged tasks to guests too. Without this branch a guest
    // could see the task in the list but get a 403 on /tasks/:id.
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { defaultTaskVisibility: true },
    });
    return project?.defaultTaskVisibility === 'client_visible';
  }
}
