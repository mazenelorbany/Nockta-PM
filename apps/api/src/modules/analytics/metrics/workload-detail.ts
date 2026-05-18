import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from '../../auth/types';
import { accessibleProjectIds } from './_shared';

/** 30-element [{date}] series oldest→newest, used as a base for trend fills. */
function emptyDailyTrend(from: Date, to: Date): { date: string; completed: number }[] {
  const out: { date: string; completed: number }[] = [];
  const fromDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const toDay = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  for (let d = new Date(fromDay); d <= toDay; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push({ date: d.toISOString().slice(0, 10), completed: 0 });
  }
  return out;
}

/**
 * Drill-down for one person on the /workload page. Returns their open task
 * list (with project + priority + due-date for routing into the task
 * drawer), priority + status breakdowns, overdue / due-soon counts, and a
 * 30-day completion trend so the modal can show speed alongside load.
 *
 * Scoped to projects the actor can read — a client user opening the
 * modal won't see internal tasks. Internal-only for parity with workload().
 */
export async function workloadDetail(
  prisma: PrismaService,
  _permissions: PermissionsService,
  actor: AuthenticatedUser,
  userId: string,
) {
  if (actor.kind !== 'internal') {
    throw new ForbiddenException('Internal only');
  }
  const projectIds = await accessibleProjectIds(prisma, actor);
  const now = new Date();
  const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, avatarUrl: true },
  });

  if (projectIds.length === 0 || !user) {
    return {
      user,
      summary: { total: 0, points: 0, loadScore: 0, byPriority: { Critical: 0, High: 0, Medium: 0, Low: 0 } },
      byStatus: [],
      overdueCount: 0,
      dueSoonCount: 0,
      openTasks: [],
      completionTrend: emptyDailyTrend(thirtyDaysAgo, now),
    };
  }

  const [openTasksRaw, doneEvents] = await Promise.all([
    prisma.task.findMany({
      where: {
        assigneeUserId: userId,
        projectId: { in: projectIds },
        status: { notIn: ['Done', 'Approved'] },
      },
      select: {
        id: true,
        keyNumber: true,
        title: true,
        status: true,
        priority: true,
        isBlocked: true,
        dueDate: true,
        estimate: true,
        updatedAt: true,
        project: { select: { id: true, key: true, name: true } },
      },
      orderBy: [{ priority: 'asc' }, { dueDate: 'asc' }, { updatedAt: 'desc' }],
    }),
    prisma.event.findMany({
      where: {
        type: 'TaskStatusChanged',
        actorUserId: userId,
        projectId: { in: projectIds },
        createdAt: { gte: thirtyDaysAgo },
      },
      select: { createdAt: true, payload: true },
    }),
  ]);

  // --- Summary (mirrors the row math in workload()) ---
  const weights = { Critical: 4, High: 3, Medium: 2, Low: 1 } as const;
  const byPriority = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  const byStatusMap = new Map<string, number>();
  let points = 0;
  let loadScore = 0;
  let overdueCount = 0;
  let dueSoonCount = 0;
  for (const t of openTasksRaw) {
    byPriority[t.priority] += 1;
    loadScore += weights[t.priority];
    points += t.estimate ?? 0;
    byStatusMap.set(t.status, (byStatusMap.get(t.status) ?? 0) + 1);
    if (t.dueDate) {
      if (t.dueDate < now) overdueCount += 1;
      else if (t.dueDate < sevenDaysAhead) dueSoonCount += 1;
    }
  }

  // --- 30-day completion trend ---
  // Count TaskStatusChanged events where the actor moved a task to a
  // terminal status. Keyed on the actor (not the assignee) so credit goes
  // to whoever did the merge/approval, matching how /workload itself
  // measures "open" by current assignment.
  const completionsByDay = new Map<string, number>();
  for (const e of doneEvents) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const to = p['toStatus'];
    if (to !== 'Done' && to !== 'Approved') continue;
    const key = e.createdAt.toISOString().slice(0, 10);
    completionsByDay.set(key, (completionsByDay.get(key) ?? 0) + 1);
  }
  const completionTrend = emptyDailyTrend(thirtyDaysAgo, now).map((d) => ({
    date: d.date,
    completed: completionsByDay.get(d.date) ?? 0,
  }));

  return {
    user,
    summary: {
      total: openTasksRaw.length,
      points,
      loadScore,
      byPriority,
    },
    byStatus: Array.from(byStatusMap.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    overdueCount,
    dueSoonCount,
    openTasks: openTasksRaw.map((t) => ({
      id: t.id,
      keyNumber: t.keyNumber,
      title: t.title,
      status: t.status,
      priority: t.priority,
      isBlocked: t.isBlocked,
      dueDate: t.dueDate?.toISOString() ?? null,
      estimate: t.estimate,
      project: t.project,
    })),
    completionTrend,
  };
}
