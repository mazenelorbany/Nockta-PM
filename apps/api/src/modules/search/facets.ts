import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';

// Facet aggregation for the search panel. Given a where clause (already
// scoped + permission-checked by the caller), returns per-dimension counts
// over the filtered task set. One groupBy per dimension is intentional —
// Postgres GROUP BY GROUPING SETS would fold them into one query, but
// Prisma doesn't expose it; the parallel groupBys are short enough on the
// typical 10k-task project. Each dim capped at 200 to keep the UI bounded.

export interface FacetResult {
  byStatus: { status: string; count: number }[];
  byPriority: { priority: string; count: number }[];
  byType: { type: string; count: number }[];
  byProject: { projectId: string; name: string; count: number }[];
  byAssignee: { userId: string; name: string; count: number }[];
  bySprint: { sprintId: string; name: string; count: number }[];
  byLabel: { labelId: string; name: string; count: number }[];
}

export function emptyFacets(): FacetResult {
  return {
    byStatus: [],
    byPriority: [],
    byType: [],
    byProject: [],
    byAssignee: [],
    bySprint: [],
    byLabel: [],
  };
}

export async function computeFacets(
  prisma: PrismaService,
  where: Prisma.TaskWhereInput,
): Promise<FacetResult> {
  // Pull a candidate id set so we can join into TaskLabel for the labels
  // facet without re-running the where clause through that relation.
  const matchedTasks = await prisma.task.findMany({
    where,
    select: { id: true, projectId: true, assigneeUserId: true, sprintId: true },
    take: 5000, // safety ceiling — beyond this the facet panel is useless anyway
  });
  const taskIds = matchedTasks.map((t) => t.id);

  // Prisma 5+ requires orderBy whenever take is set on groupBy. We sort by
  // the grouping field so the result is deterministic across runs (the
  // facet panel does its own count-desc sort in render).
  const [byStatus, byPriority, byType, byProject, byAssigneeRaw, bySprintRaw, byLabelRaw] = await Promise.all([
    prisma.task.groupBy({
      by: ['status'],
      where: { id: { in: taskIds } },
      _count: { _all: true },
      orderBy: { status: 'asc' },
      take: 200,
    }),
    prisma.task.groupBy({
      by: ['priority'],
      where: { id: { in: taskIds } },
      _count: { _all: true },
      orderBy: { priority: 'asc' },
      take: 200,
    }),
    prisma.task.groupBy({
      by: ['type'],
      where: { id: { in: taskIds } },
      _count: { _all: true },
      orderBy: { type: 'asc' },
      take: 200,
    }),
    prisma.task.groupBy({
      by: ['projectId'],
      where: { id: { in: taskIds } },
      _count: { _all: true },
      orderBy: { projectId: 'asc' },
      take: 200,
    }),
    prisma.task.groupBy({
      by: ['assigneeUserId'],
      where: { id: { in: taskIds }, assigneeUserId: { not: null } },
      _count: { _all: true },
      orderBy: { assigneeUserId: 'asc' },
      take: 200,
    }),
    prisma.task.groupBy({
      by: ['sprintId'],
      where: { id: { in: taskIds }, sprintId: { not: null } },
      _count: { _all: true },
      orderBy: { sprintId: 'asc' },
      take: 200,
    }),
    prisma.taskLabel.groupBy({
      by: ['labelId'],
      where: { taskId: { in: taskIds } },
      _count: { _all: true },
      orderBy: { labelId: 'asc' },
      take: 200,
    }),
  ]);

  // Hydrate the FK rows with display names in a second pass — one query per
  // dimension that needs it. Cheaper than including in the groupBy since
  // groupBy doesn't support relation includes.
  const [projects, users, sprints, labels] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: byProject.map((g) => g.projectId) } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: {
        id: {
          in: byAssigneeRaw
            .map((g) => g.assigneeUserId)
            .filter((v): v is string => v !== null),
        },
      },
      select: { id: true, name: true },
    }),
    prisma.sprint.findMany({
      where: {
        id: {
          in: bySprintRaw
            .map((g) => g.sprintId)
            .filter((v): v is string => v !== null),
        },
      },
      select: { id: true, name: true },
    }),
    prisma.label.findMany({
      where: { id: { in: byLabelRaw.map((g) => g.labelId) } },
      select: { id: true, name: true },
    }),
  ]);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const sprintName = new Map(sprints.map((s) => [s.id, s.name]));
  const labelName = new Map(labels.map((l) => [l.id, l.name]));

  return {
    byStatus: byStatus.map((g) => ({ status: g.status, count: g._count._all })),
    byPriority: byPriority.map((g) => ({ priority: g.priority, count: g._count._all })),
    byType: byType.map((g) => ({ type: g.type, count: g._count._all })),
    byProject: byProject.map((g) => ({
      projectId: g.projectId,
      name: projectName.get(g.projectId) ?? g.projectId,
      count: g._count._all,
    })),
    byAssignee: byAssigneeRaw
      .filter((g) => g.assigneeUserId !== null)
      .map((g) => ({
        userId: g.assigneeUserId as string,
        name: userName.get(g.assigneeUserId as string) ?? 'Unknown',
        count: g._count._all,
      })),
    bySprint: bySprintRaw
      .filter((g) => g.sprintId !== null)
      .map((g) => ({
        sprintId: g.sprintId as string,
        name: sprintName.get(g.sprintId as string) ?? 'Unknown',
        count: g._count._all,
      })),
    byLabel: byLabelRaw.map((g) => ({
      labelId: g.labelId,
      name: labelName.get(g.labelId) ?? 'Unknown',
      count: g._count._all,
    })),
  };
}
