import { Prisma } from '@prisma/client';

import type { PrismaService } from '../../../prisma/prisma.service';

export async function cycleTime(
  prisma: PrismaService,
  projectId: string,
  since: Date,
): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ avg_seconds: number | null }[]>(Prisma.sql`
    WITH done_events AS (
      SELECT e."entityId" AS task_id, e."createdAt" AS done_at
      FROM "Event" e
      WHERE e.type = 'TaskStatusChanged'
        AND e."projectId" = ${projectId}::uuid
        AND e."createdAt" >= ${since}
        AND e.payload ->> 'toStatus' IN ('Done', 'Approved')
    ),
    progress_events AS (
      SELECT e."entityId" AS task_id, MIN(e."createdAt") AS first_in_progress
      FROM "Event" e
      WHERE e.type = 'TaskStatusChanged'
        AND e.payload ->> 'toStatus' = 'In Progress'
      GROUP BY e."entityId"
    )
    SELECT AVG(EXTRACT(EPOCH FROM (d.done_at - p.first_in_progress))) AS avg_seconds
    FROM done_events d
    JOIN progress_events p ON p.task_id = d.task_id
    WHERE d.done_at > p.first_in_progress;
  `);
  const seconds = rows[0]?.avg_seconds;
  return seconds ? Math.round(seconds / 3600) : null;
}
