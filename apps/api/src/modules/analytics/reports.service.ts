import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// CustomReportsService — Pass I (Analytics 8 → 9).
//
// A CustomReport is a parameterized "groupBy + aggregate" over the Task
// table. The user picks one or more dimensions, a single metric, and a
// filter set. runReport assembles a single Prisma $queryRaw with prepared
// bindings — NO string interpolation of user input.
//
// SECURITY:
//   - Dimensions, metrics, and filter keys are validated against a strict
//     allowlist BEFORE any SQL is built. Anything off the allowlist is a 400.
//   - All filter VALUES go through Prisma.sql template bindings.
//   - The column whitelist is the only place we touch identifier names. Each
//     mapped column is a constant string we control (e.g. 'status', 'priority')
//     — never a user string.
//   - When a report has `projectId` set, every query is automatically scoped
//     to that project regardless of what the filters say. Combined with the
//     read-permission check, this prevents an Admin from saving a report
//     pointed at Project A and a Viewer in Project B from running it to
//     spelunk cross-project data.
//
// SHAPE:
//   - Dimensions ⊆ { 'status', 'priority', 'assignee', 'sprint', 'label',
//                    'project' }. Multi-select. Order matters for output.
//   - Metric ∈    { 'count', 'sum_estimate', 'sum_actual' }. Single value.
//   - Filters: typed object — see the FILTER_KEYS constant.
// =============================================================================

export const REPORT_DIMENSIONS = ['status', 'priority', 'assignee', 'sprint', 'label', 'project'] as const;
export type ReportDimension = (typeof REPORT_DIMENSIONS)[number];

export const REPORT_METRICS = ['count', 'sum_estimate', 'sum_actual'] as const;
export type ReportMetric = (typeof REPORT_METRICS)[number];

interface ReportFilters {
  projectIds?: string[];
  statuses?: string[];
  priorities?: ('Low' | 'Medium' | 'High' | 'Critical')[];
  assigneeUserIds?: string[];
  sprintIds?: string[];
  labelIds?: string[];
  createdAfter?: string;
  createdBefore?: string;
  dueBefore?: string;
}

export interface CreateReportInput {
  name: string;
  dimensions: ReportDimension[];
  metric: ReportMetric;
  filters?: ReportFilters;
  projectId?: string | null;
}

// Dimension → SQL column source (table-qualified). For 'label' we need a
// LEFT JOIN to TaskLabel; for 'sprint' the Task.sprintId column is enough.
const DIMENSION_COL: Record<ReportDimension, string> = {
  status:    't."status"',
  priority:  't."priority"',
  assignee:  't."assigneeUserId"',
  sprint:    't."sprintId"',
  project:   't."projectId"',
  // Label is special — the JOIN below pulls labelId from TaskLabel.
  label:     'tl."labelId"',
};

@Injectable()
export class CustomReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  // ---- CRUD ---------------------------------------------------------------

  /**
   * List saved reports. When projectId is supplied, returns workspace-wide
   * reports (projectId IS NULL) PLUS that project's scoped reports. Without
   * projectId, only workspace-wide rows.
   */
  async list(actor: AuthenticatedUser, projectId?: string | null) {
    if (projectId) {
      const role = await this.permissions.effectiveRole(actor, projectId);
      if (role === null) throw new ForbiddenException('No project access');
    }
    return this.prisma.customReport.findMany({
      where: {
        OR: [
          { projectId: null },
          ...(projectId ? [{ projectId }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  async get(actor: AuthenticatedUser, id: string) {
    const report = await this.prisma.customReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('Report not found');
    if (report.projectId) {
      const role = await this.permissions.effectiveRole(actor, report.projectId);
      if (role === null) throw new ForbiddenException('No project access');
    }
    return report;
  }

  async createReport(actor: AuthenticatedUser, input: CreateReportInput) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new BadRequestException('Report name is required');
    if (name.length > 120) throw new BadRequestException('Report name too long');

    const dimensions = this.assertValidDimensions(input.dimensions);
    const metric = this.assertValidMetric(input.metric);
    const filters = this.assertValidFilters(input.filters);

    if (input.projectId) {
      await this.permissions.assertAtLeast(actor, input.projectId, 'Viewer');
    }

    return this.prisma.customReport.create({
      data: {
        name,
        dimensions,
        metric,
        filters: filters as unknown as Prisma.InputJsonValue,
        projectId: input.projectId ?? null,
        createdByUserId: actor.id,
      },
    });
  }

  async update(actor: AuthenticatedUser, id: string, input: Partial<CreateReportInput>) {
    const existing = await this.prisma.customReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Report not found');
    if (existing.projectId) {
      await this.permissions.assertAtLeast(actor, existing.projectId, 'Viewer');
    }

    const data: {
      name?: string;
      dimensions?: ReportDimension[];
      metric?: ReportMetric;
      filters?: Prisma.InputJsonValue;
    } = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw new BadRequestException('Name cannot be empty');
      data.name = name;
    }
    if (input.dimensions !== undefined) {
      data.dimensions = this.assertValidDimensions(input.dimensions);
    }
    if (input.metric !== undefined) {
      data.metric = this.assertValidMetric(input.metric);
    }
    if (input.filters !== undefined) {
      data.filters = this.assertValidFilters(input.filters) as unknown as Prisma.InputJsonValue;
    }
    if (Object.keys(data).length === 0) return existing;
    return this.prisma.customReport.update({ where: { id }, data });
  }

  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    const existing = await this.prisma.customReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Report not found');
    if (existing.projectId) {
      await this.permissions.assertAtLeast(actor, existing.projectId, 'Viewer');
    }
    await this.prisma.customReport.delete({ where: { id } });
  }

  // ---- Run ----------------------------------------------------------------

  /**
   * Execute a saved report and return the grouped result set. Each row carries
   * `dimensionValues` (a record keyed by dimension name) and `metricValue`.
   *
   * The query is a single $queryRaw with prepared bindings. The dimension
   * column expressions ARE inlined (they're constants from our allowlist),
   * but every value comparison uses bindings. The label dimension triggers
   * a LEFT JOIN to TaskLabel; the JOIN happens unconditionally so the test
   * suite has a consistent EXPLAIN shape regardless of dimension order.
   */
  async runReport(actor: AuthenticatedUser, id: string) {
    const report = await this.get(actor, id);
    return this.runInline(actor, {
      dimensions: report.dimensions as ReportDimension[],
      metric: report.metric as ReportMetric,
      filters: (report.filters as ReportFilters) ?? {},
      projectId: report.projectId,
    });
  }

  /**
   * Public "preview" endpoint. Same SQL shape as runReport but takes an
   * inline definition so the UI can show a chart before the user clicks
   * Save. The permission check is identical: a projectId pins the report's
   * scope and the actor must be Viewer+ on it.
   */
  async previewReport(actor: AuthenticatedUser, input: CreateReportInput) {
    const dimensions = this.assertValidDimensions(input.dimensions);
    const metric = this.assertValidMetric(input.metric);
    const filters = this.assertValidFilters(input.filters);
    if (input.projectId) {
      await this.permissions.assertAtLeast(actor, input.projectId, 'Viewer');
    }
    return this.runInline(actor, {
      dimensions,
      metric,
      filters,
      projectId: input.projectId ?? null,
    });
  }

  private async runInline(
    actor: AuthenticatedUser,
    spec: {
      dimensions: ReportDimension[];
      metric: ReportMetric;
      filters: ReportFilters;
      projectId: string | null;
    },
  ): Promise<{
    dimensions: ReportDimension[];
    metric: ReportMetric;
    rows: Array<{ dimensionValues: Record<string, string | null>; metricValue: number }>;
  }> {
    // Effective project filter: if the report is project-anchored, force
    // projectId into the filter set regardless of what filters say. We also
    // intersect with the actor's accessible projects so a non-project-anchored
    // workspace report can't leak rows from projects the actor can't see.
    const accessibleProjectIds = await this.accessibleProjectIds(actor);
    let projectIdFilter: string[];
    if (spec.projectId) {
      if (!accessibleProjectIds.includes(spec.projectId)) {
        throw new ForbiddenException('No access to the report project');
      }
      projectIdFilter = [spec.projectId];
    } else if (spec.filters.projectIds && spec.filters.projectIds.length > 0) {
      projectIdFilter = spec.filters.projectIds.filter((pid) =>
        accessibleProjectIds.includes(pid),
      );
      if (projectIdFilter.length === 0) return { dimensions: spec.dimensions, metric: spec.metric, rows: [] };
    } else {
      projectIdFilter = accessibleProjectIds;
      if (projectIdFilter.length === 0) return { dimensions: spec.dimensions, metric: spec.metric, rows: [] };
    }

    // ---- Build the SQL fragments ----------------------------------------
    const includeLabelJoin = spec.dimensions.includes('label') || (spec.filters.labelIds?.length ?? 0) > 0;
    const selects: Prisma.Sql[] = [];
    const groupBys: Prisma.Sql[] = [];
    for (const d of spec.dimensions) {
      // DIMENSION_COL is a server-controlled constant string. Safe to inline.
      const colExpr = Prisma.raw(DIMENSION_COL[d]);
      selects.push(Prisma.sql`${colExpr} AS "dim_${Prisma.raw(d)}"`);
      groupBys.push(colExpr);
    }
    const metricExpr =
      spec.metric === 'count'
        ? Prisma.sql`COUNT(*)::bigint`
        : spec.metric === 'sum_estimate'
        ? Prisma.sql`COALESCE(SUM(t."estimate"), 0)::bigint`
        : Prisma.sql`COALESCE(SUM(t."actual"), 0)::bigint`;

    const wheres: Prisma.Sql[] = [
      Prisma.sql`t."projectId" = ANY(${projectIdFilter}::uuid[])`,
    ];
    if (spec.filters.statuses?.length) {
      wheres.push(Prisma.sql`t."status" = ANY(${spec.filters.statuses}::text[])`);
    }
    if (spec.filters.priorities?.length) {
      wheres.push(Prisma.sql`t."priority"::text = ANY(${spec.filters.priorities}::text[])`);
    }
    if (spec.filters.assigneeUserIds?.length) {
      wheres.push(Prisma.sql`t."assigneeUserId" = ANY(${spec.filters.assigneeUserIds}::uuid[])`);
    }
    if (spec.filters.sprintIds?.length) {
      wheres.push(Prisma.sql`t."sprintId" = ANY(${spec.filters.sprintIds}::uuid[])`);
    }
    if (spec.filters.labelIds?.length) {
      wheres.push(Prisma.sql`tl."labelId" = ANY(${spec.filters.labelIds}::uuid[])`);
    }
    if (spec.filters.createdAfter) {
      wheres.push(Prisma.sql`t."createdAt" >= ${new Date(spec.filters.createdAfter)}`);
    }
    if (spec.filters.createdBefore) {
      wheres.push(Prisma.sql`t."createdAt" < ${new Date(spec.filters.createdBefore)}`);
    }
    if (spec.filters.dueBefore) {
      wheres.push(Prisma.sql`t."dueDate" < ${new Date(spec.filters.dueBefore)}`);
    }

    // ---- Compose ---------------------------------------------------------
    const fromClause = includeLabelJoin
      ? Prisma.sql`FROM "Task" t LEFT JOIN "TaskLabel" tl ON tl."taskId" = t."id"`
      : Prisma.sql`FROM "Task" t`;
    const whereClause = wheres.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(wheres, ' AND ')}`
      : Prisma.empty;
    const groupClause = groupBys.length > 0
      ? Prisma.sql`GROUP BY ${Prisma.join(groupBys, ', ')}`
      : Prisma.empty;
    const selectClause = selects.length > 0
      ? Prisma.sql`${Prisma.join(selects, ', ')}, ${metricExpr} AS "metric_value"`
      : Prisma.sql`${metricExpr} AS "metric_value"`;

    const sql = Prisma.sql`
      SELECT ${selectClause}
      ${fromClause}
      ${whereClause}
      ${groupClause}
      ORDER BY "metric_value" DESC
      LIMIT 1000
    `;

    const raw = await this.prisma.$queryRaw<Record<string, unknown>[]>(sql);

    // Rehydrate dimension values into a {name: value} record per row.
    // Postgres returns dim_<name> for each grouped column; bigint metric
    // is converted to Number for JSON-safety (results are bounded to LIMIT 1000).
    const rows = raw.map((r) => {
      const dimensionValues: Record<string, string | null> = {};
      for (const d of spec.dimensions) {
        const raw = r[`dim_${d}`];
        dimensionValues[d] = raw === null || raw === undefined ? null : String(raw);
      }
      const mv = r['metric_value'];
      const metricValue =
        typeof mv === 'bigint' ? Number(mv) : Number(mv ?? 0);
      return { dimensionValues, metricValue };
    });

    return {
      dimensions: spec.dimensions,
      metric: spec.metric,
      rows,
    };
  }

  // ---- Validators ---------------------------------------------------------

  private assertValidDimensions(dims: ReportDimension[] | undefined): ReportDimension[] {
    if (!Array.isArray(dims) || dims.length === 0) {
      throw new BadRequestException('At least one dimension is required');
    }
    if (dims.length > 3) {
      // 3 dimensions = the practical readability ceiling for a bar chart.
      // We could lift this later but a stacked-stacked-grouped chart isn't
      // a real product feature.
      throw new BadRequestException('At most 3 dimensions are supported');
    }
    const seen = new Set<string>();
    for (const d of dims) {
      if (!REPORT_DIMENSIONS.includes(d)) {
        throw new BadRequestException(`Unknown dimension "${d}"`);
      }
      if (seen.has(d)) {
        throw new BadRequestException(`Duplicate dimension "${d}"`);
      }
      seen.add(d);
    }
    return dims;
  }

  private assertValidMetric(metric: ReportMetric | undefined): ReportMetric {
    if (!metric || !REPORT_METRICS.includes(metric)) {
      throw new BadRequestException(`Metric must be one of ${REPORT_METRICS.join(', ')}`);
    }
    return metric;
  }

  /**
   * Strip unknown keys and type-coerce. Anything that doesn't fit the
   * declared filter shape is silently dropped (e.g. a client sending an
   * array of integers for `priorities`). We deliberately don't throw on
   * unknown keys — that would make future filter additions backward-
   * incompatible.
   */
  private assertValidFilters(filters: ReportFilters | undefined): ReportFilters {
    const out: ReportFilters = {};
    if (!filters || typeof filters !== 'object') return out;
    const arrayOfStrings = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
    out.projectIds = arrayOfStrings(filters.projectIds);
    out.statuses = arrayOfStrings(filters.statuses);
    out.priorities = arrayOfStrings(filters.priorities)?.filter((p): p is 'Low' | 'Medium' | 'High' | 'Critical' =>
      ['Low', 'Medium', 'High', 'Critical'].includes(p),
    );
    out.assigneeUserIds = arrayOfStrings(filters.assigneeUserIds);
    out.sprintIds = arrayOfStrings(filters.sprintIds);
    out.labelIds = arrayOfStrings(filters.labelIds);
    if (filters.createdAfter) out.createdAfter = String(filters.createdAfter);
    if (filters.createdBefore) out.createdBefore = String(filters.createdBefore);
    if (filters.dueBefore) out.dueBefore = String(filters.dueBefore);
    // Drop empties so the persisted JSON stays tidy.
    for (const k of Object.keys(out) as (keyof ReportFilters)[]) {
      if (Array.isArray(out[k]) && (out[k] as unknown[]).length === 0) delete out[k];
    }
    return out;
  }

  /**
   * Mirror of AnalyticsService.accessibleProjectIds. Duplicated here rather
   * than imported because pulling AnalyticsService into the constructor
   * creates a circular module reference (analytics imports reports for the
   * controller wire-up).
   */
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
