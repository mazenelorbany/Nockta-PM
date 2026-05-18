import { ForbiddenException } from '@nestjs/common';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from '../../auth/types';

import { accessibleProjectIds } from './_shared';

/**
 * Per-person open-task workload across every project the actor can see.
 * Returns counts + sum of estimates + a priority-weighted "load" score so
 * Critical/High items can be visually weighted in the UI.
 */
export async function workload(
  prisma: PrismaService,
  _permissions: PermissionsService,
  actor: AuthenticatedUser,
  opts: { projectId?: string; teamId?: string } = {},
) {
  if (actor.kind !== 'internal') {
    throw new ForbiddenException('Internal only');
  }
  const projectIds = opts.projectId
    ? [opts.projectId]
    : await accessibleProjectIds(prisma, actor);
  if (projectIds.length === 0) return { rows: [] };

  // If a team is supplied, only include that team's members.
  let userIdFilter: string[] | undefined;
  if (opts.teamId) {
    const members = await prisma.teamMember.findMany({
      where: { teamId: opts.teamId }, select: { userId: true },
    });
    userIdFilter = members.map((m) => m.userId);
    if (userIdFilter.length === 0) return { rows: [] };
  }

  const grouped = await prisma.task.groupBy({
    by: ['assigneeUserId', 'priority'],
    where: {
      projectId: { in: projectIds },
      status: { notIn: ['Done', 'Approved'] },
      assigneeUserId: userIdFilter ? { in: userIdFilter } : { not: null },
    },
    _count: { _all: true },
    _sum: { estimate: true },
  });

  // Reshape into per-user rows.
  type Row = {
    userId: string;
    total: number;
    points: number;
    byPriority: { Critical: number; High: number; Medium: number; Low: number };
    loadScore: number;
  };
  const map = new Map<string, Row>();
  const weights = { Critical: 4, High: 3, Medium: 2, Low: 1 };
  for (const g of grouped) {
    if (!g.assigneeUserId) continue;
    const row = map.get(g.assigneeUserId) ?? {
      userId: g.assigneeUserId,
      total: 0,
      points: 0,
      byPriority: { Critical: 0, High: 0, Medium: 0, Low: 0 },
      loadScore: 0,
    };
    row.total += g._count._all;
    row.points += g._sum.estimate ?? 0;
    row.byPriority[g.priority] = g._count._all;
    row.loadScore += g._count._all * weights[g.priority];
    map.set(g.assigneeUserId, row);
  }
  const rows = Array.from(map.values()).sort((a, b) => b.loadScore - a.loadScore);

  // Hydrate with names.
  const users = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.userId) } },
    select: { id: true, name: true, email: true, avatarUrl: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  // Read the last 7 days of DailyWorkloadSnapshot for every user in the
  // result set. The scheduler at WorkloadSnapshotScheduler writes one row
  // per (user, day) at 00:05 UTC; today's count is implicit from the
  // current `r.total`. Missing days (the user had zero open work that
  // day) are filled with 0.
  const userIds = rows.map((r) => r.userId);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const snapshots = userIds.length > 0
    ? await prisma.dailyWorkloadSnapshot.findMany({
        where: { userId: { in: userIds }, date: { gte: sevenDaysAgo } },
        select: { userId: true, date: true, openTasksCount: true },
      })
    : [];
  // Build a (userId, dateKey) → count map for O(1) lookup.
  const snapMap = new Map<string, number>();
  for (const s of snapshots) {
    const key = `${s.userId}::${s.date.toISOString().slice(0, 10)}`;
    snapMap.set(key, s.openTasksCount);
  }
  // For each user, build a 7-element series oldest→newest. Today (index 6)
  // uses the live `r.total` rather than the snapshot — the snapshot is
  // written at 00:05 UTC and we want the latest live count to drive the
  // most-recent sparkline point.
  function buildSeries(userId: string, todayTotal: number): number[] {
    const out: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dateKey = d.toISOString().slice(0, 10);
      if (i === 0) {
        out.push(todayTotal);
      } else {
        out.push(snapMap.get(`${userId}::${dateKey}`) ?? 0);
      }
    }
    return out;
  }

  return {
    rows: rows.map((r) => ({
      ...r,
      user: userMap.get(r.userId) ?? null,
      series: buildSeries(r.userId, r.total),
    })),
  };
}
