import { Prisma, type Priority } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';
import type { ParsedFilters } from './query-parser';

// Postgres full-text search building blocks: the FTS candidate query, the
// Prisma where-clause builder shared between searchTasks() and facets(), and
// the Cmd+K doc search. All functions are pure (apart from the prisma I/O)
// and free of NestJS DI so they're trivially unit-testable.

export interface SearchInput {
  q?: string;
  projectId?: string;
  status?: string;
  priority?: Priority;
  assigneeUserId?: string;
  sprintId?: string;
  isBlocked?: boolean;
  reportedByClient?: boolean;
  hasAttachments?: boolean;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
  /**
   * Multi-select facet filters. AND'd onto the where clause alongside the
   * single-value filters above. UI builds these from the facet sidebar.
   */
  projectIds?: string[];
  assigneeUserIds?: string[];
  labelIds?: string[];
  statuses?: string[];
  priorities?: Priority[];
  types?: string[];
  sprintIds?: string[];
}

export function isUndefinedColumnError(err: unknown): boolean {
  // Postgres 42703 = undefined_column. Surfaces when search_vector hasn't been
  // created (companion.sql §5 not yet applied). We fall back to ILIKE rather
  // than 500.
  const code = (err as { code?: string })?.code;
  if (code === '42703') return true;
  const msg = (err as { message?: string })?.message ?? '';
  return /column .*search_vector.* does not exist/i.test(msg);
}

/**
 * Returns up to 500 task IDs ranked by Postgres FTS relevance against `q`,
 * intersected with the supplied project filter and (for clients) the
 * client_visible visibility gate. Joins to Comment so a hit in any
 * non-deleted comment surfaces the parent task. Highest rank first.
 */
export async function ftsCandidateIds(
  prisma: PrismaService,
  q: string,
  projectIds: string[],
  clientOnly: boolean,
): Promise<string[]> {
  const visibilityClause = clientOnly
    ? Prisma.sql`AND t."visibility" = 'client_visible'`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT t."id"
    FROM "Task" t
    LEFT JOIN LATERAL (
      SELECT MAX(ts_rank(c."search_vector", websearch_to_tsquery('english', ${q}))) AS rank
      FROM "Comment" c
      WHERE c."taskId" = t."id"
        AND c."deletedAt" IS NULL
        AND c."search_vector" @@ websearch_to_tsquery('english', ${q})
    ) cm ON true
    WHERE t."projectId" IN (${Prisma.join(projectIds)})
      ${visibilityClause}
      AND (
        t."search_vector" @@ websearch_to_tsquery('english', ${q})
        OR cm.rank IS NOT NULL
      )
    ORDER BY (
      COALESCE(ts_rank(t."search_vector", websearch_to_tsquery('english', ${q})), 0)
      + COALESCE(cm.rank, 0) * 0.5
    ) DESC,
    t."createdAt" DESC
    LIMIT 500
  `);
  return rows.map((r) => r.id);
}

export interface DocSearchRow {
  id: string;
  title: string;
  projectId: string;
  projectKey: string;
  projectName: string;
}

/**
 * FTS-ranked doc search backing Cmd+K. Uses the generated search_vector
 * column (title weighted A, body weighted B). Caller handles the
 * 42703 fallback to ILIKE if companion.sql hasn't been applied.
 */
export async function ftsSearchDocs(
  prisma: PrismaService,
  projectIds: string[],
  q: string,
  take: number,
): Promise<DocSearchRow[]> {
  return prisma.$queryRaw<DocSearchRow[]>(Prisma.sql`
    SELECT
      d."id",
      d."title",
      d."projectId",
      p."key" AS "projectKey",
      p."name" AS "projectName"
    FROM "Doc" d
    JOIN "Project" p ON p."id" = d."projectId"
    WHERE d."projectId" IN (${Prisma.join(projectIds)})
      AND d."archivedAt" IS NULL
      AND d."search_vector" @@ websearch_to_tsquery('english', ${q})
    ORDER BY ts_rank(d."search_vector", websearch_to_tsquery('english', ${q})) DESC,
             d."updatedAt" DESC
    LIMIT ${take}
  `);
}

/**
 * Shared where-clause builder for searchTasks() + facets(). Pulling this
 * out keeps facet counts honest: any filter that narrows the result list
 * narrows the facet aggregates by the same predicate.
 *
 * `rankedIds` is only non-null when called from searchTasks() with a
 * usable FTS rank; facets() passes null and we fall back to the ILIKE
 * branch. The visibility gate (client_visible for clients) is applied
 * here so callers can't forget it.
 */
export function buildWhere(
  actor: AuthenticatedUser,
  input: SearchInput,
  parsedFilters: ParsedFilters,
  projectFilter: string[],
  q: string | undefined,
  rankedIds: string[] | null,
): Prisma.TaskWhereInput {
  // Merge parsed filters with the explicit multi-select inputs from the
  // controller. Multi-select wins by appending — both lists are
  // independent (e.g. UI may pass extra labels picked from the sidebar
  // ON TOP of one typed into the query box).
  const statuses: string[] = [];
  if (parsedFilters.status) statuses.push(parsedFilters.status);
  if (input.statuses) statuses.push(...input.statuses);
  const priorities: Priority[] = [];
  if (parsedFilters.priorities) priorities.push(...(parsedFilters.priorities as Priority[]));
  if (input.priority) priorities.push(input.priority);
  if (input.priorities) priorities.push(...input.priorities);
  const projectIds = input.projectIds && input.projectIds.length > 0
    ? input.projectIds.filter((id) => projectFilter.includes(id))
    : projectFilter;

  // Assignee resolution from parsed filters. assignee:me uses the actor;
  // assignee:@email is resolved via a relation filter against User.email
  // — keeps us off a synchronous lookup at parse time.
  const assigneeUserIds: string[] = [];
  if (input.assigneeUserId) assigneeUserIds.push(input.assigneeUserId);
  if (input.assigneeUserIds) assigneeUserIds.push(...input.assigneeUserIds);
  let assigneeEmail: string | undefined;
  if (parsedFilters.assignee?.kind === 'me') {
    assigneeUserIds.push(actor.id);
  } else if (parsedFilters.assignee?.kind === 'email') {
    assigneeEmail = parsedFilters.assignee.email;
  }

  const labelNames: string[] = parsedFilters.labels ?? [];

  const createdAt: { gte?: Date; lte?: Date } = {};
  if (input.from) createdAt.gte = input.from;
  if (input.to) createdAt.lte = input.to;
  if (parsedFilters.dateRange?.from) createdAt.gte = parsedFilters.dateRange.from;
  if (parsedFilters.dateRange?.to) createdAt.lte = parsedFilters.dateRange.to;

  const where: Prisma.TaskWhereInput = {
    projectId: { in: projectIds },
    ...(q && rankedIds && rankedIds.length > 0
      ? { id: { in: rankedIds } }
      : q
      ? {
          OR: [
            { title: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
            { comments: { some: { bodyMd: { contains: q, mode: 'insensitive' }, deletedAt: null } } },
          ],
        }
      : {}),
    ...(statuses.length === 1
      ? { status: statuses[0] }
      : statuses.length > 1
      ? { status: { in: statuses } }
      : {}),
    ...(priorities.length === 1
      ? { priority: priorities[0] }
      : priorities.length > 1
      ? { priority: { in: priorities } }
      : {}),
    ...(input.sprintId ? { sprintId: input.sprintId } : {}),
    ...(input.sprintIds && input.sprintIds.length > 0
      ? { sprintId: { in: input.sprintIds } }
      : {}),
    ...(assigneeUserIds.length === 1
      ? { assigneeUserId: assigneeUserIds[0] }
      : assigneeUserIds.length > 1
      ? { assigneeUserId: { in: assigneeUserIds } }
      : {}),
    ...(assigneeEmail
      ? { assignee: { is: { email: { equals: assigneeEmail, mode: 'insensitive' } } } }
      : {}),
    ...(input.types && input.types.length > 0 ? { type: { in: input.types as never } } : {}),
    ...(labelNames.length > 0
      ? { labels: { some: { label: { name: { in: labelNames } } } } }
      : {}),
    ...(input.labelIds && input.labelIds.length > 0
      ? { labels: { some: { labelId: { in: input.labelIds } } } }
      : {}),
    ...(input.isBlocked !== undefined ? { isBlocked: input.isBlocked } : {}),
    ...(input.reportedByClient !== undefined ? { reportedByClient: input.reportedByClient } : {}),
    ...(createdAt.gte !== undefined || createdAt.lte !== undefined ? { createdAt } : {}),
  };
  if (actor.kind === 'client') {
    where.visibility = 'client_visible';
  }
  return where;
}
