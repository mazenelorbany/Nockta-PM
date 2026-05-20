import { BadRequestException, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import { AnalyticsService } from './analytics.service';
import { SprintReportService } from './sprint-report.service';
import { renderSprintReportPdf } from './sprint-pdf-renderer';

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly sprintReports: SprintReportService,
  ) {}

  @Get('me')
  personal(@CurrentUser() actor: AuthenticatedUser) {
    return this.analytics.personal(actor);
  }

  @Get('projects/:projectId')
  project(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.analytics.project(actor, projectId);
  }

  /**
   * Per-assignee rollup for the Project Dashboard tab — task counts +
   * worklog totals for every teammate on the project, plus an Unassigned
   * pseudo-row for unowned work.
   */
  @Get('projects/:projectId/team-stats')
  teamStats(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.analytics.teamStats(actor, projectId);
  }

  @Get('org')
  org(@CurrentUser() actor: AuthenticatedUser) {
    return this.analytics.org(actor);
  }

  @Get('sprints/:sprintId/burndown')
  burndown(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sprintId', new ParseUUIDPipe()) sprintId: string,
  ) {
    return this.analytics.burndown(actor, sprintId);
  }

  @Get('projects/:projectId/worklog-report')
  worklogReport(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('weeks', new ParseIntPipe({ optional: true })) weeks?: number,
  ) {
    return this.analytics.worklogReport(actor, projectId, weeks ?? 12);
  }

  /**
   * Workspace-wide per-user hours roll-up for an arbitrary date range.
   * Admin-only — see worklog-by-user.ts for the rationale (the personal
   * + per-project views cover non-admin self-service).
   *
   * Query params:
   *   - from        ISO date (required) — inclusive lower bound.
   *   - to          ISO date (required) — EXCLUSIVE upper bound, so a
   *                 month range like 2026-04-01..2026-05-01 is right-open.
   *   - projectId   UUID (optional)     — narrow to a single project.
   */
  @Get('worklog/by-user')
  worklogByUser(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('projectId') projectId?: string,
  ) {
    if (!from || !to) {
      throw new BadRequestException('from and to (ISO dates) are required');
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('from and to must be valid ISO dates');
    }
    return this.analytics.worklogByUser(actor, {
      from: fromDate,
      to: toDate,
      ...(projectId ? { projectId } : {}),
    });
  }

  @Get('workload')
  workload(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('projectId') projectId?: string,
    @Query('teamId') teamId?: string,
  ) {
    return this.analytics.workload(actor, {
      ...(projectId ? { projectId } : {}),
      ...(teamId ? { teamId } : {}),
    });
  }

  @Get('workload/:userId')
  workloadDetail(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.analytics.workloadDetail(actor, userId);
  }

  @Get('projects/:projectId/velocity')
  velocity(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.analytics.velocity(actor, projectId);
  }

  /**
   * Pass I (Sprints 8→9) — goal hit-rate report. Returns the headline rate
   * + a per-sprint series for plotting alongside the velocity chart. Caller
   * may pass `?since=2025-01-01` to scope the rolling window; default is
   * "all completed sprints in this project".
   */
  @Get('projects/:projectId/goal-hit-rate')
  goalHitRate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('since') since?: string,
  ) {
    const sinceDate = since ? new Date(since) : undefined;
    if (sinceDate && Number.isNaN(sinceDate.getTime())) {
      return this.analytics.goalHitRate(actor, projectId);
    }
    return this.analytics.goalHitRate(actor, projectId, sinceDate);
  }

  @Get('projects/:projectId/cumulative-flow')
  cumulativeFlow(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('days', new ParseIntPipe({ optional: true })) days?: number,
  ) {
    return this.analytics.cumulativeFlow(actor, projectId, Math.min(180, Math.max(7, days ?? 30)));
  }

  // ----- Branded sprint / project PDF reports -----

  /**
   * Stream a branded sprint report PDF. Manager+ on the project. The report
   * shows the sprint's completed tasks, hours logged per task, hours logged
   * per user, summary tiles, and a Nockta header strip.
   *
   * `from`/`to` (ISO dates) optionally override the sprint's start/end
   * dates so a manager can pull a "this sprint up to today" snapshot
   * before the sprint formally closes.
   */
  @Get('sprints/:sprintId/report.pdf')
  async sprintReportPdf(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sprintId', new ParseUUIDPipe()) sprintId: string,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<void> {
    const override: { from?: Date; to?: Date } = {};
    if (from) {
      const d = new Date(from);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid `from`');
      override.from = d;
    }
    if (to) {
      const d = new Date(to);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid `to`');
      override.to = d;
    }
    const payload = await this.sprintReports.buildSprintReport(actor, sprintId, override);
    const buffer = await renderSprintReportPdf(payload);
    const slug = `${payload.project.key}_${payload.sprint.name}`.replace(/[^a-z0-9-_.]+/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-sprint-report.pdf"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.send(buffer);
  }

  /**
   * Stream a branded project-level report PDF for an arbitrary date window.
   * Manager+ on the project. Useful when work isn't sprint-organised or for
   * monthly executive summaries.
   */
  @Get('projects/:projectId/report.pdf')
  async projectReportPdf(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<void> {
    if (!from || !to) throw new BadRequestException('from and to are required for the project report');
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('Invalid from/to');
    }
    const payload = await this.sprintReports.buildProjectReport(actor, projectId, {
      from: fromDate,
      to: toDate,
    });
    const buffer = await renderSprintReportPdf(payload);
    const slug = `${payload.project.key}_${from.slice(0, 10)}_${to.slice(0, 10)}`.replace(/[^a-z0-9-_.]+/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-project-report.pdf"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.send(buffer);
  }
}
