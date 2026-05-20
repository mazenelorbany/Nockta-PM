import { BadRequestException, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

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
}
