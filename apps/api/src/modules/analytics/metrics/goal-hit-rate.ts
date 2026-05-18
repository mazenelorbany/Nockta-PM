import type { PrismaService } from '../../../prisma/prisma.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from '../../auth/types';

/**
 * Across all completed sprints in a project (optionally filtered by
 * `since`), how many had a SprintGoalEvaluation row with goalAchieved=true?
 * Pass I — Sprints 8 → 9.
 *
 * The numerator is "sprints with goalAchieved=true". The denominator is
 * "completed sprints with any evaluation row" so a project that doesn't
 * use the evaluation feature yet doesn't get a misleading 0% — it gets a
 * `totalEvaluated: 0` and `rate: null` and the UI hides the badge.
 *
 * `since` filters by Sprint.endDate (the canonical "when did this sprint
 * close" timestamp). Sprints without an endDate are excluded — they're
 * either still in flight or were force-deleted and never closed cleanly.
 */
export async function goalHitRate(
  prisma: PrismaService,
  permissions: PermissionsService,
  actor: AuthenticatedUser,
  projectId: string,
  since?: Date,
): Promise<{
  totalSprints: number;
  totalEvaluated: number;
  goalsAchieved: number;
  rate: number | null;
  series: Array<{ sprintId: string; name: string; endDate: string | null; goalAchieved: boolean | null }>;
}> {
  await permissions.assertAtLeast(actor, projectId, 'Viewer');
  const sprints = await prisma.sprint.findMany({
    where: {
      projectId,
      state: 'completed',
      ...(since ? { endDate: { gte: since } } : {}),
    },
    orderBy: { endDate: 'asc' },
    include: {
      goalEval: { select: { goalAchieved: true } },
    },
  });

  const totalSprints = sprints.length;
  const evaluated = sprints.filter((s) => s.goalEval !== null);
  const goalsAchieved = evaluated.filter((s) => s.goalEval?.goalAchieved === true).length;
  const totalEvaluated = evaluated.length;
  const rate = totalEvaluated > 0 ? goalsAchieved / totalEvaluated : null;

  return {
    totalSprints,
    totalEvaluated,
    goalsAchieved,
    rate,
    series: sprints.map((s) => ({
      sprintId: s.id,
      name: s.name,
      endDate: s.endDate?.toISOString() ?? null,
      goalAchieved: s.goalEval?.goalAchieved ?? null,
    })),
  };
}
