import type { PrismaService } from '../../../prisma/prisma.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from '../../auth/types';

/**
 * Walk back through ISO-week buckets (Monday-anchored, UTC) and count
 * consecutive weeks where the user met `targetSeconds`. The current week
 * only counts when it's ALREADY hit — a Monday-morning render shouldn't
 * inflate the streak.
 *
 * Implementation: pull the last ~26 weeks of Worklog rows in one query,
 * bucket client-side. Capped at 26 to bound memory; longer streaks render
 * as "26+".
 */
async function computeWeeklyStreak(
  prisma: PrismaService,
  userId: string,
  startOfThisWeek: Date,
  totalThisWeekSeconds: number,
  targetSeconds: number,
): Promise<number> {
  const HORIZON_WEEKS = 26;
  const earliest = new Date(startOfThisWeek.getTime() - HORIZON_WEEKS * 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<{ week_start: Date; seconds: bigint }[]>`
    SELECT date_trunc('week', "startedAt") AS week_start, SUM("seconds")::bigint AS seconds
    FROM "Worklog"
    WHERE "userId" = ${userId}::uuid
      AND "startedAt" >= ${earliest}
      AND "startedAt" < ${startOfThisWeek}
    GROUP BY 1
    ORDER BY 1 DESC
  `;
  // Postgres date_trunc('week', ...) returns Monday 00:00 UTC.
  const seenWeeks = new Map<number, number>();
  for (const r of rows) {
    seenWeeks.set(r.week_start.getTime(), Number(r.seconds));
  }

  let streak = 0;
  // Optionally include the current week if it's ALREADY met the target.
  if (totalThisWeekSeconds >= targetSeconds) {
    streak += 1;
  }
  // Walk backward from "last week" until we miss.
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  for (let i = 1; i <= HORIZON_WEEKS; i++) {
    const wk = new Date(startOfThisWeek.getTime() - i * weekMs).getTime();
    const got = seenWeeks.get(wk) ?? 0;
    if (got >= targetSeconds) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

export async function personal(
  prisma: PrismaService,
  _permissions: PermissionsService,
  actor: AuthenticatedUser,
) {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  // Start-of-this-week (Monday) in UTC. We don't honour user TZ here — a 1-day
  // edge case is acceptable for a personal dashboard widget.
  const startOfWeek = new Date(now);
  const dow = startOfWeek.getUTCDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? 6 : dow - 1;
  startOfWeek.setUTCDate(startOfWeek.getUTCDate() - diff);
  startOfWeek.setUTCHours(0, 0, 0, 0);

  const [openByPriority, overdue, watching, recentMentions, weekSeconds, weekByDay, userPrefs] = await Promise.all([
    prisma.task.groupBy({
      by: ['priority'],
      where: { assigneeUserId: actor.id, status: { notIn: ['Done', 'Approved'] } },
      _count: true,
    }),
    prisma.task.count({
      where: {
        assigneeUserId: actor.id,
        dueDate: { lt: now },
        status: { notIn: ['Done', 'Approved'] },
      },
    }),
    prisma.taskWatcher.count({ where: { userId: actor.id } }),
    prisma.commentMention.count({
      where: { userId: actor.id, comment: { createdAt: { gte: sevenDaysAgo } } },
    }),
    prisma.worklog.aggregate({
      where: { userId: actor.id, startedAt: { gte: startOfWeek } },
      _sum: { seconds: true },
    }),
    prisma.$queryRaw<{ day: Date; seconds: bigint }[]>`
      SELECT date_trunc('day', "startedAt") AS day, SUM("seconds")::bigint AS seconds
      FROM "Worklog"
      WHERE "userId" = ${actor.id}::uuid AND "startedAt" >= ${startOfWeek}
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    prisma.user.findUnique({
      where: { id: actor.id },
      select: { weeklyHoursTarget: true },
    }),
  ]);

  const weeklyHoursTarget = userPrefs?.weeklyHoursTarget ?? null;
  const targetSeconds = weeklyHoursTarget !== null ? weeklyHoursTarget * 3600 : null;
  const totalWeekSeconds = weekSeconds._sum.seconds ?? 0;

  // Streak — only computed when the user actually set a target. Counts back
  // through prior ISO weeks (Mon-Sun in UTC) and tallies how many of them
  // hit `>= target`, stopping on the first miss. The current in-flight week
  // counts only if the user ALREADY hit the target this week (so a fresh
  // Monday morning doesn't show "streak 5" and then drop to 4 on Sunday).
  const streakWeeks = targetSeconds !== null
    ? await computeWeeklyStreak(prisma, actor.id, startOfWeek, totalWeekSeconds, targetSeconds)
    : 0;

  return {
    openByPriority: openByPriority.map((p) => ({ priority: p.priority, count: p._count })),
    overdueCount: overdue,
    watchingCount: watching,
    mentionsLast7Days: recentMentions,
    timeThisWeek: {
      totalSeconds: totalWeekSeconds,
      byDay: weekByDay.map((r) => ({
        day: r.day.toISOString().slice(0, 10),
        seconds: Number(r.seconds),
      })),
    },
    weeklyTarget: weeklyHoursTarget !== null
      ? {
          hours: weeklyHoursTarget,
          secondsLogged: totalWeekSeconds,
          secondsTarget: targetSeconds ?? 0,
          hit: targetSeconds !== null && totalWeekSeconds >= targetSeconds,
          streakWeeks,
        }
      : null,
  };
}
