import type { PrismaService } from '../../../prisma/prisma.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from '../../auth/types';

export type SprintVelocityRow = {
  sprintId: string;
  name: string;
  endDate: Date | null;
  plannedCount: number;
  plannedEstimate: number;
  completedCount: number;
  completedEstimate: number;
};

/**
 * Velocity history with computed average + naive next-sprint projection.
 * Used by the Analytics page chart. Returns oldest→newest sprints.
 */
export async function velocity(
  _prisma: PrismaService,
  permissions: PermissionsService,
  actor: AuthenticatedUser,
  projectId: string,
  sprintVelocity: (projectId: string) => Promise<SprintVelocityRow[]>,
) {
  await permissions.assertAtLeast(actor, projectId, 'Viewer');
  const sprints = await sprintVelocity(projectId);
  if (sprints.length === 0) {
    return { sprints: [], averageCount: 0, averageEstimate: 0, projectedNext: null };
  }
  const sumCount = sprints.reduce((acc, s) => acc + s.completedCount, 0);
  const sumEst = sprints.reduce((acc, s) => acc + s.completedEstimate, 0);
  const averageCount = sumCount / sprints.length;
  const averageEstimate = sumEst / sprints.length;
  // Light EWMA so the most recent 1-2 sprints carry more weight than 6
  // weeks ago. Alpha 0.4 = ~5-sprint half-life.
  const alpha = 0.4;
  let ewCount = sprints[0].completedCount;
  let ewEst = sprints[0].completedEstimate;
  for (let i = 1; i < sprints.length; i++) {
    ewCount = alpha * sprints[i].completedCount + (1 - alpha) * ewCount;
    ewEst = alpha * sprints[i].completedEstimate + (1 - alpha) * ewEst;
  }
  return {
    sprints,
    averageCount: Number(averageCount.toFixed(1)),
    averageEstimate: Number(averageEstimate.toFixed(1)),
    projectedNext: {
      count: Math.round(ewCount),
      estimate: Math.round(ewEst),
    },
  };
}

/**
 * Returns the last 6 completed sprints (oldest→newest) with planned-vs-
 * completed counts + estimates reconstructed from membership history.
 */
export async function sprintVelocity(prisma: PrismaService, projectId: string): Promise<SprintVelocityRow[]> {
  const completed = await prisma.sprint.findMany({
    where: { projectId, state: 'completed' },
    orderBy: { endDate: 'desc' },
    take: 6,
    include: {
      // Live membership — what's STILL in the sprint right now. For a
      // completed sprint that's the final set; for tasks that got booted
      // back to the backlog at completion, the membership snapshot below
      // is what carries "this used to be planned scope".
      tasks: {
        select: { id: true, status: true, estimate: true },
      },
      memberships: {
        select: { taskId: true, addedAt: true, removedAt: true },
      },
    },
  });

  // For each sprint, planned scope = the set of tasks that were members at
  // any point during its lifecycle (joined live tasks ∪ task ids appearing
  // in the membership history). Completed scope = the subset whose CURRENT
  // status is Done/Approved. This handles the "moved out incomplete" case
  // cleanly: a task removed from the sprint at completion stays counted in
  // planned, contributing to the planned-vs-completed gap on the chart.
  return completed
    .map((s) => {
      const liveIds = new Set(s.tasks.map((t) => t.id));
      const histIds = new Set(s.memberships.map((m) => m.taskId));
      const plannedIds = new Set<string>([...liveIds, ...histIds]);
      const completedTasks = s.tasks.filter(
        (t) => t.status === 'Done' || t.status === 'Approved',
      );
      const plannedEstimate = s.tasks.reduce((sum, t) => sum + (t.estimate ?? 0), 0);
      return {
        sprintId: s.id,
        name: s.name,
        endDate: s.endDate,
        plannedCount: plannedIds.size,
        plannedEstimate,
        completedCount: completedTasks.length,
        completedEstimate: completedTasks.reduce((sum, t) => sum + (t.estimate ?? 0), 0),
      };
    })
    .reverse();
}
