import type { PrismaService } from '../../../prisma/prisma.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from '../../auth/types';

/**
 * Per-member worklog matrix for a single project, bucketed by week. Rows are
 * the teammates who logged time on the project's tasks; columns are the last
 * `weeks` ISO weeks (Monday-start, UTC), oldest → newest. Cells hold seconds
 * logged in that week.
 *
 * The week bucket is computed in SQL via `date_trunc('week', ...)` which is
 * Postgres-native and uses Monday as the week start — matching the rest of
 * the codebase (personal dashboard, team-stats start-of-week).
 *
 * Returns rows sorted by total descending; users with zero seconds across
 * the window are filtered out so the table doesn't show empty rows.
 */
export async function worklogReport(
  prisma: PrismaService,
  permissions: PermissionsService,
  actor: AuthenticatedUser,
  projectId: string,
  weeks: number,
): Promise<{
  weekStartsUTC: string[];
  rows: Array<{
    user: { id: string; name: string; email: string; avatarUrl: string | null };
    cells: number[];
    totalSeconds: number;
  }>;
}> {
  await permissions.assertAtLeast(actor, projectId, 'Viewer');
  const clampedWeeks = Math.min(52, Math.max(1, Math.floor(weeks) || 12));

  // Compute the start-of-window: Monday of (clampedWeeks - 1) weeks ago, UTC.
  const now = new Date();
  const dow = now.getUTCDay();
  const diff = dow === 0 ? 6 : dow - 1;
  const thisWeekStart = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - diff,
  ));
  const windowStart = new Date(thisWeekStart);
  windowStart.setUTCDate(windowStart.getUTCDate() - (clampedWeeks - 1) * 7);

  // Build the ordered list of week-start ISO dates (oldest → newest).
  const weekStartsUTC: string[] = [];
  const weekIndexByISO = new Map<string, number>();
  for (let i = 0; i < clampedWeeks; i++) {
    const d = new Date(windowStart);
    d.setUTCDate(d.getUTCDate() + i * 7);
    const iso = d.toISOString().slice(0, 10);
    weekStartsUTC.push(iso);
    weekIndexByISO.set(iso, i);
  }

  // Raw SQL: groupBy userId + date_trunc('week', startedAt). Prisma's
  // groupBy can't accept an expression so we drop to $queryRaw. The cast
  // to ::date matches the ISO-string output we use as the bucket key.
  const rawRows = await prisma.$queryRaw<{
    userId: string;
    weekStart: Date;
    seconds: bigint;
  }[]>`
    SELECT w."userId" AS "userId",
           date_trunc('week', w."startedAt") AS "weekStart",
           SUM(w."seconds")::bigint AS seconds
    FROM "Worklog" w
    JOIN "Task" t ON t.id = w."taskId"
    WHERE t."projectId" = ${projectId}::uuid
      AND w."startedAt" >= ${windowStart}
    GROUP BY w."userId", date_trunc('week', w."startedAt")
  `;

  // Fold the rows into per-user cell arrays. Use the same ISO-date format
  // as the column keys; date_trunc returns Monday 00:00 UTC.
  type Acc = { cells: number[]; total: number };
  const byUser = new Map<string, Acc>();
  for (const r of rawRows) {
    const iso = r.weekStart.toISOString().slice(0, 10);
    const colIdx = weekIndexByISO.get(iso);
    // Defensive: ignore rows that fall outside our generated bucket list
    // (could happen if windowStart drifted by a day across DST boundaries
    // since Postgres date_trunc is timezone-aware on `timestamp with time
    // zone`. Practically a non-issue with UTC inputs.)
    if (colIdx === undefined) continue;
    const seconds = Number(r.seconds);
    let acc = byUser.get(r.userId);
    if (!acc) {
      acc = { cells: new Array(clampedWeeks).fill(0), total: 0 };
      byUser.set(r.userId, acc);
    }
    acc.cells[colIdx] = (acc.cells[colIdx] ?? 0) + seconds;
    acc.total += seconds;
  }

  if (byUser.size === 0) {
    return { weekStartsUTC, rows: [] };
  }

  const users = await prisma.user.findMany({
    where: { id: { in: Array.from(byUser.keys()) } },
    select: { id: true, name: true, email: true, avatarUrl: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const rows = Array.from(byUser.entries())
    .map(([userId, acc]) => {
      const u = userById.get(userId);
      if (!u) return null;
      return {
        user: { id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl },
        cells: acc.cells,
        totalSeconds: acc.total,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null && r.totalSeconds > 0)
    .sort((a, b) => b.totalSeconds - a.totalSeconds);

  return { weekStartsUTC, rows };
}
