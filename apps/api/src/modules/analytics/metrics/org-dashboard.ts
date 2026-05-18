import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from '../../auth/types';

export async function org(
  prisma: PrismaService,
  _permissions: PermissionsService,
  actor: AuthenticatedUser,
) {
  if (!(actor.kind === 'internal' && actor.companyRole === 'Admin')) {
    throw new ForbiddenException('Admin only');
  }
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [activeProjects, activeEngineers, blockedOrgWide, deploymentsLast30, workloadByAssignee] = await Promise.all([
    prisma.project.count({ where: { archivedAt: null } }),
    prisma.user.count({ where: { kind: 'internal', archivedAt: null } }),
    prisma.task.count({ where: { isBlocked: true } }),
    prisma.deployment.findMany({
      where: { startedAt: { gte: thirtyDaysAgo } },
      select: { status: true },
    }),
    prisma.task.groupBy({
      by: ['assigneeUserId'],
      where: { status: { notIn: ['Done', 'Approved'] }, assigneeUserId: { not: null } },
      _count: true,
    }),
  ]);

  const succeeded = deploymentsLast30.filter((d) => d.status === 'succeeded').length;

  return {
    activeProjects,
    activeEngineers,
    blockedTasks: blockedOrgWide,
    deploymentsLast30Days: {
      total: deploymentsLast30.length,
      succeeded,
      successRate:
        deploymentsLast30.length > 0
          ? Math.round((succeeded / deploymentsLast30.length) * 100)
          : null,
    },
    workloadTop: workloadByAssignee
      .sort((a, b) => b._count - a._count)
      .slice(0, 20)
      .map((w) => ({ userId: w.assigneeUserId, openTasks: w._count })),
  };
}
