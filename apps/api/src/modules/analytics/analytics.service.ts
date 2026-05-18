import { Injectable } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { personal as personalMetric } from './metrics/personal';
import { project as projectMetric } from './metrics/project-dashboard';
import { teamStats as teamStatsMetric } from './metrics/team-stats';
import { org as orgMetric } from './metrics/org-dashboard';
import { burndown as burndownMetric } from './metrics/burndown';
import { worklogReport as worklogReportMetric } from './metrics/worklog-report';
import { workload as workloadMetric } from './metrics/workload';
import { workloadDetail as workloadDetailMetric } from './metrics/workload-detail';
import { goalHitRate as goalHitRateMetric } from './metrics/goal-hit-rate';
import { velocity as velocityMetric, sprintVelocity as sprintVelocityHelper } from './metrics/velocity';
import { cumulativeFlow as cumulativeFlowMetric } from './metrics/cumulative-flow';
import { cycleTime as cycleTimeHelper } from './metrics/cycle-time';

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  // ---------------- Personal dashboard ----------------

  async personal(actor: AuthenticatedUser) {
    return personalMetric(this.prisma, this.permissions, actor);
  }

  // ---------------- Project dashboard ----------------

  async project(actor: AuthenticatedUser, projectId: string) {
    return projectMetric(
      this.prisma,
      this.permissions,
      actor,
      projectId,
      (pid) => this.sprintVelocity(pid),
      (pid, since) => this.cycleTime(pid, since),
    );
  }

  // ---------------- Per-project team stats ----------------

  async teamStats(actor: AuthenticatedUser, projectId: string) {
    return teamStatsMetric(this.prisma, this.permissions, actor, projectId);
  }

  // ---------------- Org dashboard (Admin only) ----------------

  async org(actor: AuthenticatedUser) {
    return orgMetric(this.prisma, this.permissions, actor);
  }

  // ---------------- Sprint burndown ----------------

  async burndown(actor: AuthenticatedUser, sprintId: string) {
    return burndownMetric(this.prisma, this.permissions, actor, sprintId);
  }

  // ---------------- Per-project worklog report ----------------

  async worklogReport(
    actor: AuthenticatedUser,
    projectId: string,
    weeks: number,
  ) {
    return worklogReportMetric(this.prisma, this.permissions, actor, projectId, weeks);
  }

  // ---------------- Workload (cross-project) ----------------

  async workload(actor: AuthenticatedUser, opts: { projectId?: string; teamId?: string } = {}) {
    return workloadMetric(this.prisma, this.permissions, actor, opts);
  }

  async workloadDetail(actor: AuthenticatedUser, userId: string) {
    return workloadDetailMetric(this.prisma, this.permissions, actor, userId);
  }

  // ---------------- Sprint goal hit-rate (Pass I) ----------------

  async goalHitRate(
    actor: AuthenticatedUser,
    projectId: string,
    since?: Date,
  ) {
    return goalHitRateMetric(this.prisma, this.permissions, actor, projectId, since);
  }

  // ---------------- Velocity (richer report) ----------------

  async velocity(actor: AuthenticatedUser, projectId: string) {
    return velocityMetric(
      this.prisma,
      this.permissions,
      actor,
      projectId,
      (pid) => this.sprintVelocity(pid),
    );
  }

  // ---------------- Cumulative Flow Diagram ----------------

  async cumulativeFlow(actor: AuthenticatedUser, projectId: string, days = 30) {
    return cumulativeFlowMetric(this.prisma, this.permissions, actor, projectId, days);
  }

  // ---------------- Helpers ----------------

  /**
   * Public wrapper around the private sprintVelocity. Sibling modules
   * (AiSprintPlanningService) call this without re-importing the same
   * Prisma query. Skips the permissions check because callers are expected
   * to have already gated on `projectId`.
   */
  async sprintVelocityForProjectId(projectId: string) {
    return this.sprintVelocity(projectId);
  }

  private async sprintVelocity(projectId: string) {
    return sprintVelocityHelper(this.prisma, projectId);
  }

  private async cycleTime(projectId: string, since: Date): Promise<number | null> {
    return cycleTimeHelper(this.prisma, projectId, since);
  }
}
