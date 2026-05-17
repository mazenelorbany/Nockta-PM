import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Priority } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeLimit, paginate } from '../../common/pagination/cursor-pagination';
import type { AuthenticatedUser } from '../auth/types';
import { ElasticSearchService } from './elastic-search.service';

const PRIORITY_VALUES = ['Low', 'Medium', 'High', 'Critical'] as const;
type PriorityVal = (typeof PRIORITY_VALUES)[number];
function isPriority(v: string): v is PriorityVal {
  return (PRIORITY_VALUES as readonly string[]).includes(v);
}

/**
 * Structured filters extracted from the free-text query by parseQuery(). Each
 * field is independent; a filter that didn't appear in the input is left
 * undefined. `dateRange` covers both `created:>7d` and `created:<2024-01-01`
 * shapes — the parser fills `from` and/or `to` from those.
 */
export interface ParsedFilters {
  status?: string;
  assignee?: { kind: 'me' } | { kind: 'email'; email: string };
  labels?: string[];
  priorities?: PriorityVal[];
  dateRange?: { from?: Date; to?: Date };
}

export interface ParsedQuery {
  text: string;
  filters: ParsedFilters;
  parseError?: string;
}

/**
 * Token regex used by parseQuery — captures the leading `key:` plus its value.
 * The value is either a double-quoted string (whitespace allowed) or a bare
 * sequence of non-whitespace characters. Capture groups:
 *   1: key
 *   2: quoted value (double-quote-bounded; quotes stripped)
 *   3: bare value
 * One of (2, 3) is always populated when the regex matches.
 */
const FILTER_TOKEN_REGEX = /(\w+):(?:"([^"]+)"|(\S+))/g;

function isUndefinedColumnError(err: unknown): boolean {
  // Postgres 42703 = undefined_column. Surfaces when search_vector hasn't been
  // created (companion.sql §5 not yet applied). We fall back to ILIKE rather
  // than 500.
  const code = (err as { code?: string })?.code;
  if (code === '42703') return true;
  const msg = (err as { message?: string })?.message ?? '';
  return /column .*search_vector.* does not exist/i.test(msg);
}

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

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly elastic: ElasticSearchService,
  ) {}

  /**
   * Permission-aware task search.
   *
   * When `q` is present we query the Postgres FTS GIN index on
   * `Task.search_vector` (built in companion.sql §5) plus a join against
   * comments to surface tasks whose conversation matches. If the generated
   * column is missing (e.g. a fresh dev DB without companion.sql applied)
   * the raw query throws 42703 and we transparently fall back to ILIKE.
   */
  async searchTasks(actor: AuthenticatedUser, input: SearchInput) {
    const accessibleProjectIds = await this.accessibleProjectIds(actor);
    if (accessibleProjectIds.length === 0) return { items: [], nextCursor: null };

    const limit = normalizeLimit(input.limit);
    const projectFilter =
      input.projectId && accessibleProjectIds.includes(input.projectId)
        ? [input.projectId]
        : accessibleProjectIds;

    // Parse structured filters out of the free-text q. The remaining text is
    // what gets handed to FTS / OpenSearch; the parsed filters get AND'd onto
    // the where clause below. If the user typed garbage like `created:>asdf`
    // the parser returns parseError and falls back to treating the whole
    // input as free text, so search degrades gracefully instead of 400ing.
    const parsed = input.q ? this.parseQuery(input.q) : { text: '', filters: {} as ParsedFilters };
    const q = parsed.text.trim() || undefined;

    // FTS-ranked candidate set when a query is provided. Try OpenSearch
    // first (richer ranking + fuzzy match); fall back to Postgres FTS via
    // the search_vector GIN; finally fall back to ILIKE if neither is
    // available (unmigrated dev DB).
    let rankedIds: string[] | null = null;
    if (q) {
      if (this.elastic.enabled) {
        try {
          rankedIds = await this.elastic.search(q, projectFilter, actor.kind === 'client');
        } catch {
          rankedIds = null;
        }
      }
      if (rankedIds === null) {
        try {
          rankedIds = await this.ftsCandidateIds(q, projectFilter, actor.kind === 'client');
        } catch (err) {
          // 42703 = undefined_column (companion.sql not yet applied). Fall back
          // to ILIKE so search still works in unmigrated environments.
          if (!isUndefinedColumnError(err)) throw err;
          rankedIds = null;
        }
      }
    }

    const where = this.buildWhere(actor, input, parsed.filters, projectFilter, q, rankedIds);

    const useRankOrder = q && rankedIds && rankedIds.length > 0;
    const tasks = await this.prisma.task.findMany({
      where,
      // When we have an FTS rank, sort in JS below. Otherwise stable by id desc.
      orderBy: useRankOrder ? undefined : { createdAt: 'desc' },
      include: {
        project: { select: { id: true, key: true, name: true } },
        assignee: { select: { id: true, name: true, avatarUrl: true } },
      },
      take: useRankOrder ? undefined : limit + 1,
      ...(useRankOrder ? {} : input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    let ordered = tasks;
    if (useRankOrder) {
      const rankIdx = new Map(rankedIds!.map((id, i) => [id, i]));
      ordered = [...tasks].sort(
        (a, b) => (rankIdx.get(a.id) ?? 1e9) - (rankIdx.get(b.id) ?? 1e9),
      );
      // Apply cursor + limit after sorting by rank.
      if (input.cursor) {
        const idx = ordered.findIndex((t) => t.id === input.cursor);
        ordered = idx >= 0 ? ordered.slice(idx + 1) : ordered;
      }
      ordered = ordered.slice(0, limit + 1);
    }

    if (input.hasAttachments !== undefined) {
      const ids = ordered.map((t) => t.id);
      const withAttachments = await this.prisma.attachment.findMany({
        where: { parentType: 'Task', parentId: { in: ids }, deletedAt: null },
        select: { parentId: true },
      });
      const hasMap = new Set(withAttachments.map((a) => a.parentId));
      ordered = ordered.filter((t) => (input.hasAttachments ? hasMap.has(t.id) : !hasMap.has(t.id)));
    }

    return paginate(ordered.slice(0, limit + 1), limit, (t) => t.id);
  }

  // ----- doc search (Cmd+K) -----

  /**
   * Search docs by title + body across every project the actor can see.
   *
   * Uses Postgres full-text search against the generated `search_vector`
   * column (companion.sql §5b) — title weighted A, body weighted B, so a
   * match on the title outranks a match buried deep in the doc body.
   * Returns up to `limit` rows ordered by ts_rank.
   *
   * If the generated column is missing (fresh dev DB without companion.sql
   * applied), the raw query throws 42703 and we fall back to ILIKE — same
   * pattern as searchTasks() above. The fallback gives developers a
   * working Cmd+K palette even before they've applied the SQL companion.
   */
  async searchDocs(actor: AuthenticatedUser, q: string, limit = 10) {
    const trimmed = q.trim();
    if (!trimmed) return [];
    const accessibleProjectIds = await this.accessibleProjectIds(actor);
    if (accessibleProjectIds.length === 0) return [];

    const take = Math.min(limit, 25);
    try {
      const rows = await this.prisma.$queryRaw<
        {
          id: string;
          title: string;
          projectId: string;
          projectKey: string;
          projectName: string;
        }[]
      >(Prisma.sql`
        SELECT
          d."id",
          d."title",
          d."projectId",
          p."key" AS "projectKey",
          p."name" AS "projectName"
        FROM "Doc" d
        JOIN "Project" p ON p."id" = d."projectId"
        WHERE d."projectId" IN (${Prisma.join(accessibleProjectIds)})
          AND d."archivedAt" IS NULL
          AND d."search_vector" @@ websearch_to_tsquery('english', ${trimmed})
        ORDER BY ts_rank(d."search_vector", websearch_to_tsquery('english', ${trimmed})) DESC,
                 d."updatedAt" DESC
        LIMIT ${take}
      `);
      return rows;
    } catch (err) {
      // 42703 = undefined_column — search_vector hasn't been created yet.
      // Fall back to ILIKE so the palette still returns something.
      if (!isUndefinedColumnError(err)) throw err;
      const rows = await this.prisma.doc.findMany({
        where: {
          projectId: { in: accessibleProjectIds },
          archivedAt: null,
          OR: [
            { title: { contains: trimmed, mode: 'insensitive' } },
            { body: { contains: trimmed, mode: 'insensitive' } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take,
        select: {
          id: true,
          title: true,
          projectId: true,
          project: { select: { key: true, name: true } },
        },
      });
      return rows.map((d) => ({
        id: d.id,
        title: d.title,
        projectId: d.projectId,
        projectKey: d.project.key,
        projectName: d.project.name,
      }));
    }
  }

  // ----- saved searches -----
  //
  // Historical note: an earlier version of this module imagined a separate
  // `SavedView` model alongside `SavedSearch`. That model was never created —
  // the board "Views" dropdown and the search "Saved" list both store rows in
  // the single `SavedSearch` table. SavedViewsService writes to the same
  // table from a different controller. A previous version of listSaved read
  // SavedSearch twice and concat'd the results (every row showed up twice in
  // the UI); we now do one read and one delete.

  async listSaved(actor: AuthenticatedUser) {
    return this.prisma.savedSearch.findMany({
      where: { userId: actor.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async saveSearch(actor: AuthenticatedUser, name: string, query: SearchInput) {
    return this.prisma.savedSearch.create({
      data: { userId: actor.id, name, query: query as unknown as Prisma.InputJsonValue },
    });
  }

  async deleteSaved(actor: AuthenticatedUser, id: string) {
    await this.prisma.savedSearch.deleteMany({ where: { id, userId: actor.id } });
    return { ok: true };
  }

  // ----- query parser -----

  /**
   * Pull structured filters out of the free-text query. Grammar:
   *
   *   status:open                    → status filter (case-preserving)
   *   status:"in progress"           → quoted value, whitespace allowed
   *   assignee:me                    → assignee = current actor
   *   assignee:@person@example.com   → assignee by email
   *   label:bug                      → single label
   *   label:"front end"              → quoted label name
   *   priority:high                  → single priority (allowed Low/Medium/High/Critical, case-insensitive)
   *   priority:high|critical         → multi-priority via `|`
   *   created:>7d                    → created in the last 7 days (also 1h, 30m, 1mo, 1y)
   *   created:<2024-01-01            → created strictly before that ISO date
   *   created:>=2024-01-01           → ≥/<= variants accepted
   *   created:2024-01-01..2024-02-01 → range form
   *
   * Anything not matched stays in `text` for FTS. Bad ranges / unknown
   * operators degrade gracefully: we set `parseError`, drop the bad filter,
   * and leave the raw token in `text` so the user still gets results.
   */
  parseQuery(raw: string): ParsedQuery {
    const filters: ParsedFilters = {};
    let parseError: string | undefined;
    // Walk every key:value match, removing it from the text we'll return.
    // We intentionally rebuild `text` by splicing matched ranges out so that
    // whitespace around the token doesn't degenerate into double-spaces.
    const matches: { start: number; end: number; key: string; value: string }[] = [];
    for (const m of raw.matchAll(FILTER_TOKEN_REGEX)) {
      const key = m[1]!.toLowerCase();
      const value = m[2] !== undefined ? m[2] : (m[3] ?? '');
      // The match index points to the start of `key:`. We need the end of the
      // FULL match including any closing quote.
      const start = m.index ?? 0;
      const end = start + m[0]!.length;
      // Apply each known key. Unknown keys are LEFT in text — they might be a
      // colon-bearing word the user actually wants to FTS on.
      const handled = this.applyFilterToken(key, value, filters);
      if (handled === 'invalid') {
        // Bad value (e.g. created:>asdf) — capture the FIRST error and leave
        // the token in text. Subsequent good tokens still apply.
        if (parseError === undefined) {
          parseError = `Could not parse "${key}:${value}"`;
        }
        continue;
      }
      if (handled === 'consumed') {
        matches.push({ start, end, key, value });
      }
    }
    // Splice consumed matches out of the original input, preserving order.
    let text = raw;
    matches
      .slice()
      .sort((a, b) => b.start - a.start)
      .forEach((m) => {
        text = text.slice(0, m.start) + text.slice(m.end);
      });
    // Collapse double-whitespace introduced by removal.
    text = text.replace(/\s+/g, ' ').trim();
    return parseError !== undefined ? { text, filters, parseError } : { text, filters };
  }

  /**
   * Apply a single filter token to the accumulator. Returns 'consumed' when
   * the token was recognized and applied, 'invalid' when the key is known but
   * the value couldn't be parsed (caller sets parseError + leaves token in
   * text), 'unknown' when the key isn't one we recognize (caller leaves
   * token in text without flagging an error).
   */
  private applyFilterToken(
    key: string,
    value: string,
    filters: ParsedFilters,
  ): 'consumed' | 'invalid' | 'unknown' {
    if (value.length === 0) return 'unknown';
    switch (key) {
      case 'status': {
        filters.status = value;
        return 'consumed';
      }
      case 'assignee': {
        if (value === 'me') {
          filters.assignee = { kind: 'me' };
        } else {
          // Accept @email or bare email.
          const email = value.startsWith('@') ? value.slice(1) : value;
          if (!email.includes('@')) return 'invalid';
          filters.assignee = { kind: 'email', email };
        }
        return 'consumed';
      }
      case 'label': {
        (filters.labels ??= []).push(value);
        return 'consumed';
      }
      case 'priority': {
        // `priority:high|critical` → multi-select.
        const parts = value.split('|').map((p) => p.trim()).filter(Boolean);
        const accepted: PriorityVal[] = [];
        for (const p of parts) {
          const cap = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
          if (!isPriority(cap)) return 'invalid';
          accepted.push(cap);
        }
        if (accepted.length === 0) return 'invalid';
        filters.priorities = [...(filters.priorities ?? []), ...accepted];
        return 'consumed';
      }
      case 'created': {
        const range = this.parseDateRangeOp(value);
        if (range === null) return 'invalid';
        const cur = filters.dateRange ?? {};
        if (range.from !== undefined) cur.from = range.from;
        if (range.to !== undefined) cur.to = range.to;
        filters.dateRange = cur;
        return 'consumed';
      }
      default:
        return 'unknown';
    }
  }

  /**
   * Parse the value half of `created:<op><value>`. Returns null on garbage.
   * Supported forms:
   *   >7d        → from = now - 7d
   *   <2024-01-01 → to   = that ISO date (00:00:00 UTC)
   *   >=2024-01-01 / <=
   *   2024-01-01..2024-02-01 → both ends inclusive
   *
   * Relative units: m=minutes, h=hours, d=days, w=weeks, mo=months (30d),
   * y=years (365d). We deliberately keep month/year naive — calendar math
   * here would gain very little for an ad-hoc filter.
   */
  private parseDateRangeOp(value: string): { from?: Date; to?: Date } | null {
    // Range form `A..B`
    const rangeMatch = /^([^.]+)\.\.([^.]+)$/.exec(value);
    if (rangeMatch) {
      const a = this.parseRelOrAbsDate(rangeMatch[1]!);
      const b = this.parseRelOrAbsDate(rangeMatch[2]!);
      if (a === null || b === null) return null;
      return { from: a, to: b };
    }
    // Operator forms — accept >=, <=, >, <. No operator → treat as
    // single-day window (>= start, < next-day). We don't currently expose
    // that to users; the keyword grammar always demands an operator.
    const opMatch = /^(>=|<=|>|<)(.+)$/.exec(value);
    if (!opMatch) return null;
    const op = opMatch[1]!;
    const rest = opMatch[2]!;
    const date = this.parseRelOrAbsDate(rest);
    if (date === null) return null;
    switch (op) {
      case '>':
      case '>=':
        return { from: date };
      case '<':
      case '<=':
        return { to: date };
      default:
        return null;
    }
  }

  /**
   * Parse either a relative window (`7d`, `30m`, `1mo`) or an ISO date
   * (`2024-01-01` / full `2024-01-01T12:34:00Z`). Returns null on garbage.
   * For relative windows we compute now-minus-window so the filter is
   * "everything created after T".
   */
  private parseRelOrAbsDate(value: string): Date | null {
    // Relative: number + unit (m|h|d|w|mo|y). `mo` is checked before `m`
    // because mo is a longer prefix.
    const rel = /^(\d+)(mo|m|h|d|w|y)$/.exec(value);
    if (rel) {
      const n = Number.parseInt(rel[1]!, 10);
      if (!Number.isFinite(n) || n < 0) return null;
      const unit = rel[2]!;
      const ms =
        unit === 'm'
          ? n * 60 * 1000
          : unit === 'h'
          ? n * 60 * 60 * 1000
          : unit === 'd'
          ? n * 24 * 60 * 60 * 1000
          : unit === 'w'
          ? n * 7 * 24 * 60 * 60 * 1000
          : unit === 'mo'
          ? n * 30 * 24 * 60 * 60 * 1000
          : unit === 'y'
          ? n * 365 * 24 * 60 * 60 * 1000
          : NaN;
      if (!Number.isFinite(ms)) return null;
      return new Date(Date.now() - ms);
    }
    // Absolute ISO: Date constructor accepts `YYYY-MM-DD` and full ISO. We
    // explicitly reject NaN to weed out garbage like `2024-13-40`.
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  // ----- facets -----

  /**
   * Per-dimension aggregate counts over the filtered task set. The same
   * filters that searchTasks() applies are applied here, so what the user
   * sees in the sidebar matches what they'd get if they ticked every box.
   *
   * One groupBy per dimension is intentional — Postgres' GROUP BY GROUPING
   * SETS would give us all dimensions in one query, but Prisma doesn't expose
   * it; the parallel groupBys are short enough on the typical 10k-task
   * project. Each dim is capped at 200 results so the UI doesn't blow up.
   */
  async facets(actor: AuthenticatedUser, input: SearchInput) {
    const accessibleProjectIds = await this.accessibleProjectIds(actor);
    if (accessibleProjectIds.length === 0) {
      return this.emptyFacets();
    }
    const projectFilter =
      input.projectId && accessibleProjectIds.includes(input.projectId)
        ? [input.projectId]
        : accessibleProjectIds;
    const parsed = input.q ? this.parseQuery(input.q) : { text: '', filters: {} as ParsedFilters };
    const where = this.buildWhere(actor, input, parsed.filters, projectFilter, undefined, null);

    // Pull a candidate id set so we can join into TaskLabel for the labels
    // facet without re-running the where clause through that relation.
    const matchedTasks = await this.prisma.task.findMany({
      where,
      select: { id: true, projectId: true, assigneeUserId: true, sprintId: true },
      take: 5000, // safety ceiling — beyond this the facet panel is useless anyway
    });
    const taskIds = matchedTasks.map((t) => t.id);

    // Prisma 5+ requires orderBy whenever take is set on groupBy. We sort by
    // the grouping field so the result is deterministic across runs (the
    // facet panel does its own count-desc sort in render).
    const [byStatus, byPriority, byType, byProject, byAssigneeRaw, bySprintRaw, byLabelRaw] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['status'],
        where: { id: { in: taskIds } },
        _count: { _all: true },
        orderBy: { status: 'asc' },
        take: 200,
      }),
      this.prisma.task.groupBy({
        by: ['priority'],
        where: { id: { in: taskIds } },
        _count: { _all: true },
        orderBy: { priority: 'asc' },
        take: 200,
      }),
      this.prisma.task.groupBy({
        by: ['type'],
        where: { id: { in: taskIds } },
        _count: { _all: true },
        orderBy: { type: 'asc' },
        take: 200,
      }),
      this.prisma.task.groupBy({
        by: ['projectId'],
        where: { id: { in: taskIds } },
        _count: { _all: true },
        orderBy: { projectId: 'asc' },
        take: 200,
      }),
      this.prisma.task.groupBy({
        by: ['assigneeUserId'],
        where: { id: { in: taskIds }, assigneeUserId: { not: null } },
        _count: { _all: true },
        orderBy: { assigneeUserId: 'asc' },
        take: 200,
      }),
      this.prisma.task.groupBy({
        by: ['sprintId'],
        where: { id: { in: taskIds }, sprintId: { not: null } },
        _count: { _all: true },
        orderBy: { sprintId: 'asc' },
        take: 200,
      }),
      this.prisma.taskLabel.groupBy({
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
      this.prisma.project.findMany({
        where: { id: { in: byProject.map((g) => g.projectId) } },
        select: { id: true, name: true },
      }),
      this.prisma.user.findMany({
        where: {
          id: {
            in: byAssigneeRaw
              .map((g) => g.assigneeUserId)
              .filter((v): v is string => v !== null),
          },
        },
        select: { id: true, name: true },
      }),
      this.prisma.sprint.findMany({
        where: {
          id: {
            in: bySprintRaw
              .map((g) => g.sprintId)
              .filter((v): v is string => v !== null),
          },
        },
        select: { id: true, name: true },
      }),
      this.prisma.label.findMany({
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

  private emptyFacets() {
    return {
      byStatus: [] as { status: string; count: number }[],
      byPriority: [] as { priority: string; count: number }[],
      byType: [] as { type: string; count: number }[],
      byProject: [] as { projectId: string; name: string; count: number }[],
      byAssignee: [] as { userId: string; name: string; count: number }[],
      bySprint: [] as { sprintId: string; name: string; count: number }[],
      byLabel: [] as { labelId: string; name: string; count: number }[],
    };
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
  private buildWhere(
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

  // ----- promote between SavedSearch and SavedView -----
  //
  // History: SavedView and SavedSearch were originally meant to be separate
  // models. They've collapsed into one Prisma model (`savedSearch`) where the
  // `query.kind` discriminator says which surface the row drives. The
  // promote-to-X endpoints copy the query JSON across that discriminator and
  // wire `query.linkedId` both directions so the UI can hide the
  // "Promote" button once a row is already cross-linked. Both endpoints are
  // idempotent: replaying a promote that's already wired returns the existing
  // counterpart row instead of creating a duplicate.

  async promoteToView(actor: AuthenticatedUser, savedSearchId: string) {
    return this.promote(actor, savedSearchId, 'view');
  }

  async promoteToSearch(actor: AuthenticatedUser, savedViewId: string) {
    return this.promote(actor, savedViewId, 'search');
  }

  private async promote(actor: AuthenticatedUser, sourceId: string, targetKind: 'view' | 'search') {
    const source = await this.prisma.savedSearch.findUnique({ where: { id: sourceId } });
    if (!source) throw new NotFoundException('Saved row not found');
    if (source.userId !== actor.id) {
      // Cross-user reads/writes are blocked at every other writeable endpoint;
      // this one is no exception.
      throw new BadRequestException('Not your saved row');
    }
    const srcQuery =
      (source.query as Record<string, unknown> | null) ?? {};
    const linkedId = typeof srcQuery['linkedId'] === 'string' ? (srcQuery['linkedId'] as string) : undefined;
    // Idempotent path: if the cross-link already exists AND points at a row
    // that's still alive AND that row carries the right kind, return it
    // verbatim. Anything else (stale linkedId, dangling, kind drift) falls
    // through to creation.
    if (linkedId) {
      const existing = await this.prisma.savedSearch.findUnique({ where: { id: linkedId } });
      if (existing && existing.userId === actor.id) {
        const existingQuery = (existing.query as Record<string, unknown> | null) ?? {};
        if (existingQuery['kind'] === targetKind) {
          return existing;
        }
      }
    }
    // Strip prior cross-link metadata so we copy the FILTER JSON, not the
    // bookkeeping. The new row gets its own kind + linkedId.
    const { linkedId: _ignoreLinked, kind: _ignoreKind, ...filterPayload } = srcQuery;
    const target = await this.prisma.savedSearch.create({
      data: {
        userId: actor.id,
        name: source.name,
        query: {
          ...filterPayload,
          kind: targetKind,
          linkedId: source.id,
        } as Prisma.InputJsonValue,
      },
    });
    // Back-link the source so the inverse promote is a no-op next time.
    await this.prisma.savedSearch.update({
      where: { id: source.id },
      data: {
        query: {
          ...srcQuery,
          kind: targetKind === 'view' ? 'search' : 'view',
          linkedId: target.id,
        } as Prisma.InputJsonValue,
      },
    });
    return target;
  }

  // ----- helpers -----

  /**
   * Returns up to 500 task IDs ranked by Postgres FTS relevance against `q`,
   * intersected with the supplied project filter and (for clients) the
   * client_visible visibility gate. Joins to Comment so a hit in any
   * non-deleted comment surfaces the parent task. Highest rank first.
   */
  private async ftsCandidateIds(
    q: string,
    projectIds: string[],
    clientOnly: boolean,
  ): Promise<string[]> {
    const visibilityClause = clientOnly
      ? Prisma.sql`AND t."visibility" = 'client_visible'`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
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

  private async accessibleProjectIds(actor: AuthenticatedUser): Promise<string[]> {
    if (actor.kind === 'internal' && actor.companyRole === 'Admin') {
      const all = await this.prisma.project.findMany({
        where: { archivedAt: null }, select: { id: true },
      });
      return all.map((p) => p.id);
    }
    if (actor.kind === 'internal') {
      const memberships = await this.prisma.teamMember.findMany({
        where: { userId: actor.id }, select: { teamId: true },
      });
      const teamIds = memberships.map((m) => m.teamId);
      const projects = await this.prisma.project.findMany({
        where: {
          archivedAt: null,
          OR: [
            { visibility: 'public' },
            { accessGrants: { some: { userId: actor.id, subjectKind: 'user' } } },
            ...(teamIds.length > 0
              ? [{ accessGrants: { some: { subjectKind: 'team' as const, teamId: { in: teamIds } } } }]
              : []),
          ],
        },
        select: { id: true },
      });
      return projects.map((p) => p.id);
    }
    // Client
    const projects = await this.prisma.project.findMany({
      where: {
        archivedAt: null,
        accessGrants: { some: { userId: actor.id, role: 'Client', subjectKind: 'user' } },
      },
      select: { id: true },
    });
    return projects.map((p) => p.id);
  }
}
