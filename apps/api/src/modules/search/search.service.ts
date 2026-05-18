import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeLimit, paginate } from '../../common/pagination/cursor-pagination';
import type { AuthenticatedUser } from '../auth/types';
import { ElasticSearchService } from './elastic-search.service';
import { parseQuery, type ParsedFilters, type ParsedQuery } from './query-parser';
import {
  buildWhere,
  ftsCandidateIds,
  ftsSearchDocs,
  isUndefinedColumnError,
  type SearchInput,
} from './postgres-search';
import { computeFacets, emptyFacets, type FacetResult } from './facets';
import {
  deleteSaved,
  listSaved,
  promoteToSearch,
  promoteToView,
  saveSearch,
} from './search-saved';

// Re-export the public shape so existing imports (controller, DTOs, tests)
// don't have to chase the type to the new file.
export type { SearchInput } from './postgres-search';
export type { ParsedFilters, ParsedQuery } from './query-parser';
export type { FacetResult } from './facets';

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
    const parsed = input.q ? parseQuery(input.q) : { text: '', filters: {} as ParsedFilters };
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
          rankedIds = await ftsCandidateIds(this.prisma, q, projectFilter, actor.kind === 'client');
        } catch (err) {
          // 42703 = undefined_column (companion.sql not yet applied). Fall back
          // to ILIKE so search still works in unmigrated environments.
          if (!isUndefinedColumnError(err)) throw err;
          rankedIds = null;
        }
      }
    }

    const where = buildWhere(actor, input, parsed.filters, projectFilter, q, rankedIds);

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
      return await ftsSearchDocs(this.prisma, accessibleProjectIds, trimmed, take);
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

  // ----- query parser passthrough -----
  // Exposed as a method so tests + any callers that have a SearchService
  // instance in hand can hit it without a separate import.

  parseQuery(raw: string): ParsedQuery {
    return parseQuery(raw);
  }

  // ----- saved searches -----

  listSaved(actor: AuthenticatedUser) {
    return listSaved(this.prisma, actor);
  }

  saveSearch(actor: AuthenticatedUser, name: string, query: SearchInput) {
    return saveSearch(this.prisma, actor, name, query);
  }

  deleteSaved(actor: AuthenticatedUser, id: string) {
    return deleteSaved(this.prisma, actor, id);
  }

  promoteToView(actor: AuthenticatedUser, savedSearchId: string) {
    return promoteToView(this.prisma, actor, savedSearchId);
  }

  promoteToSearch(actor: AuthenticatedUser, savedViewId: string) {
    return promoteToSearch(this.prisma, actor, savedViewId);
  }

  // ----- facets -----

  /**
   * Per-dimension aggregate counts over the filtered task set. The same
   * filters that searchTasks() applies are applied here, so what the user
   * sees in the sidebar matches what they'd get if they ticked every box.
   */
  async facets(actor: AuthenticatedUser, input: SearchInput): Promise<FacetResult> {
    const accessibleProjectIds = await this.accessibleProjectIds(actor);
    if (accessibleProjectIds.length === 0) {
      return emptyFacets();
    }
    const projectFilter =
      input.projectId && accessibleProjectIds.includes(input.projectId)
        ? [input.projectId]
        : accessibleProjectIds;
    const parsed = input.q ? parseQuery(input.q) : { text: '', filters: {} as ParsedFilters };
    const where = buildWhere(actor, input, parsed.filters, projectFilter, undefined, null);
    return computeFacets(this.prisma, where);
  }

  // ----- helpers -----

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
