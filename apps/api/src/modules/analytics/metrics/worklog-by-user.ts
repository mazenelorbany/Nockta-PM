import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../auth/types';

// =============================================================================
// worklogByUser — workspace-wide per-user hours roll-up for an arbitrary date
// range. Answers the question "how many hours did each teammate log this
// month, regardless of which task they worked on".
//
// Surface:
//   GET /analytics/worklog/by-user?from=YYYY-MM-DD&to=YYYY-MM-DD&projectId?
//
// Authorisation
//   Admin-only. The personal worklog views (/worklog/me/active, the
//   Project Dashboard team-stats tab) cover the self-service case for
//   non-admins; this endpoint exposes every user's total and is therefore
//   gated to admins so a guest or contributor can't enumerate the
//   workspace's labour cost from the API.
//
// Range semantics
//   `from` is inclusive, `to` is EXCLUSIVE. The web sets `to` to the start
//   of the day after the user-picked end date so a month-spanning range
//   like 2026-04-01 → 2026-04-30 captures everything logged on the 30th.
//
// Numbers we return
//   - `totalSeconds`     — the workspace total across the window.
//   - `users[].totalSeconds`  — that user's total.
//   - `users[].entryCount`    — number of completed Worklog rows.
//   - `users[].byProject[]`   — per-project breakdown (always returned so
//                                the renderer can expand inline without a
//                                second round-trip).
//   - `users[].byDay[]`       — sparse per-day breakdown for the small
//                                trend chart in the row's expansion. Days
//                                with zero seconds are omitted.
//
// We exclude rows where `endedAt IS NULL` (running timers) so a live timer
// can't double-count or skew the report.
// =============================================================================

const MAX_RANGE_DAYS = 366; // one year + a leap day of slack

export interface WorklogByUserRow {
  user: { id: string; name: string; email: string; avatarUrl: string | null; kind: 'internal' | 'client' };
  totalSeconds: number;
  entryCount: number;
  byProject: Array<{ projectId: string; key: string; name: string; seconds: number }>;
  byDay: Array<{ date: string; seconds: number }>;
}

export interface WorklogByUserReport {
  range: { from: string; to: string };
  filters: { projectId: string | null };
  totals: {
    totalSeconds: number;
    distinctUsers: number;
    entryCount: number;
  };
  users: WorklogByUserRow[];
}

export async function worklogByUser(
  prisma: PrismaService,
  actor: AuthenticatedUser,
  input: { from: Date; to: Date; projectId?: string | null },
): Promise<WorklogByUserReport> {
  if (actor.kind !== 'internal' || actor.companyRole !== 'Admin') {
    throw new ForbiddenException('Admin only');
  }
  const { from, to, projectId } = input;
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new BadRequestException('from must be a valid date');
  }
  if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
    throw new BadRequestException('to must be a valid date');
  }
  if (from.getTime() >= to.getTime()) {
    throw new BadRequestException('from must be earlier than to');
  }
  const rangeMs = to.getTime() - from.getTime();
  if (rangeMs > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    throw new BadRequestException(`Range too large (max ${MAX_RANGE_DAYS} days)`);
  }

  // Single grouped read: (userId, projectId, day) buckets. We then fold the
  // result into per-user rows in JS — Prisma's groupBy can't take an
  // expression, so we drop to $queryRaw. Casting via ::date keeps the day
  // bucket aligned with ISO-string output for the byDay key.
  const rows = await prisma.$queryRaw<{
    userId: string;
    projectId: string;
    day: Date;
    seconds: bigint;
    entries: bigint;
  }[]>`
    SELECT
      w."userId"             AS "userId",
      t."projectId"          AS "projectId",
      date_trunc('day', w."startedAt") AS day,
      SUM(w.seconds)::bigint AS seconds,
      COUNT(*)::bigint       AS entries
    FROM "Worklog" w
    JOIN "Task" t ON t.id = w."taskId"
    WHERE w."startedAt" >= ${from}
      AND w."startedAt" <  ${to}
      AND w."endedAt"   IS NOT NULL
      AND (${projectId ?? null}::uuid IS NULL OR t."projectId" = ${projectId ?? null}::uuid)
    GROUP BY w."userId", t."projectId", date_trunc('day', w."startedAt")
  `;

  // Fold into per-user accumulators. Keep maps for project + day so we can
  // collapse duplicates that span multiple bucket rows (e.g. one user with
  // two projects logging on the same day produces two raw rows).
  type ProjectAcc = { seconds: number };
  type Acc = {
    totalSeconds: number;
    entries: number;
    byProject: Map<string, ProjectAcc>;
    byDay: Map<string, number>;
  };
  const byUser = new Map<string, Acc>();
  for (const r of rows) {
    let acc = byUser.get(r.userId);
    if (!acc) {
      acc = { totalSeconds: 0, entries: 0, byProject: new Map(), byDay: new Map() };
      byUser.set(r.userId, acc);
    }
    const sec = Number(r.seconds);
    const ent = Number(r.entries);
    acc.totalSeconds += sec;
    acc.entries += ent;

    const proj = acc.byProject.get(r.projectId);
    if (proj) proj.seconds += sec;
    else acc.byProject.set(r.projectId, { seconds: sec });

    const isoDay = r.day.toISOString().slice(0, 10);
    acc.byDay.set(isoDay, (acc.byDay.get(isoDay) ?? 0) + sec);
  }

  if (byUser.size === 0) {
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      filters: { projectId: projectId ?? null },
      totals: { totalSeconds: 0, distinctUsers: 0, entryCount: 0 },
      users: [],
    };
  }

  // Hydrate user + project metadata in one round-trip each.
  const userIds = Array.from(byUser.keys());
  const projectIds = Array.from(
    new Set(Array.from(byUser.values()).flatMap((acc) => Array.from(acc.byProject.keys()))),
  );
  const [users, projects] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true, avatarUrl: true, kind: true },
    }),
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, key: true, name: true },
    }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const out: WorklogByUserRow[] = [];
  let workspaceTotalSeconds = 0;
  let workspaceEntryCount = 0;
  for (const [userId, acc] of byUser.entries()) {
    const u = userById.get(userId);
    if (!u) continue; // user deleted mid-range; ignore.
    workspaceTotalSeconds += acc.totalSeconds;
    workspaceEntryCount += acc.entries;
    out.push({
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        avatarUrl: u.avatarUrl,
        kind: u.kind,
      },
      totalSeconds: acc.totalSeconds,
      entryCount: acc.entries,
      byProject: Array.from(acc.byProject.entries())
        .map(([pid, p]) => {
          const proj = projectById.get(pid);
          if (!proj) return null;
          return { projectId: pid, key: proj.key, name: proj.name, seconds: p.seconds };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => b.seconds - a.seconds),
      byDay: Array.from(acc.byDay.entries())
        .map(([date, seconds]) => ({ date, seconds }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    });
  }

  out.sort((a, b) => b.totalSeconds - a.totalSeconds);

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    filters: { projectId: projectId ?? null },
    totals: {
      totalSeconds: workspaceTotalSeconds,
      distinctUsers: out.length,
      entryCount: workspaceEntryCount,
    },
    users: out,
  };
}
