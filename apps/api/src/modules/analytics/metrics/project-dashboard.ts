import type { PrismaService } from '../../../prisma/prisma.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from '../../auth/types';

export async function project(
  prisma: PrismaService,
  permissions: PermissionsService,
  actor: AuthenticatedUser,
  projectId: string,
  sprintVelocity: (projectId: string) => Promise<Array<{
    sprintId: string;
    name: string;
    endDate: Date | null;
    plannedCount: number;
    plannedEstimate: number;
    completedCount: number;
    completedEstimate: number;
  }>>,
  cycleTime: (projectId: string, since: Date) => Promise<number | null>,
) {
  await permissions.assertAtLeast(actor, projectId, 'Viewer');
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [byStatus, overdue, blocked, activeSprint, deploys] = await Promise.all([
    prisma.task.groupBy({
      by: ['status'],
      where: { projectId },
      _count: true,
    }),
    prisma.task.count({
      where: { projectId, dueDate: { lt: now }, status: { notIn: ['Done', 'Approved'] } },
    }),
    prisma.task.count({ where: { projectId, isBlocked: true } }),
    prisma.sprint.findFirst({
      where: { projectId, state: 'active' },
      include: { _count: { select: { tasks: true } } },
    }),
    prisma.deployment.findMany({
      where: { projectId, startedAt: { gte: thirtyDaysAgo } },
      select: { status: true },
    }),
  ]);

  const succeeded = deploys.filter((d) => d.status === 'succeeded').length;
  const failed = deploys.filter((d) => d.status === 'failed').length;
  const total = deploys.length;

  const [velocity, cycleTimeResult] = await Promise.all([
    sprintVelocity(projectId),
    cycleTime(projectId, thirtyDaysAgo),
  ]);

  return {
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
    overdueCount: overdue,
    blockedCount: blocked,
    activeSprint,
    deploymentsLast30Days: {
      total,
      succeeded,
      failed,
      successRate: total > 0 ? Math.round((succeeded / total) * 100) : null,
    },
    sprintVelocity: velocity,
    avgCycleTimeHours: cycleTimeResult,
  };
}
