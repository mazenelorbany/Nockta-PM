import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import type { PermissionsService } from '../permissions/permissions.service';
import type { PrismaService } from '../../prisma/prisma.service';

import type { AiCostTrackingService } from './ai-cost-tracking.service';
import type { AiSprintPlanningService } from './ai-sprint-planning.service';
import type { AiStandupService } from './ai-standup.service';
import type { AiSyncService } from './ai-sync.service';
import { AI_DUPLICATE_QUEUE, AI_EMBED_QUEUE, AI_SUMMARIZE_QUEUE } from './ai.queues';

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly sync: AiSyncService,
    private readonly standup: AiStandupService,
    private readonly sprintPlanning: AiSprintPlanningService,
    private readonly costs: AiCostTrackingService,
    @InjectQueue(AI_EMBED_QUEUE) private readonly embedQueue: Queue,
    @InjectQueue(AI_DUPLICATE_QUEUE) private readonly dupQueue: Queue,
    @InjectQueue(AI_SUMMARIZE_QUEUE) private readonly sumQueue: Queue,
  ) {}

  // ---------- Sync endpoints — return results inline ----------

  @Post('sprints/:sprintId/summarize-now')
  summarizeSprintNow(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sprintId', new ParseUUIDPipe()) sprintId: string,
  ) {
    return this.sync.summarizeSprint(actor, sprintId);
  }

  @Get('sprints/:sprintId/summary')
  async getSprintSummary(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sprintId', new ParseUUIDPipe()) sprintId: string,
  ) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      select: { projectId: true, aiSummary: true, aiSummaryAt: true },
    });
    if (!sprint) return { summary: null, generatedAt: null };
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Viewer');
    return { summary: sprint.aiSummary, generatedAt: sprint.aiSummaryAt };
  }

  @Get('tasks/:taskId/similar')
  findSimilar(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.sync.findSimilarTasks(actor, taskId);
  }

  @Post('tasks/:taskId/expand-description')
  expandDescription(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.sync.expandTitleToDescription(actor, taskId);
  }

  @Post('users/:userId/standup')
  // Renamed handler from `standup` to `generateStandup` so it doesn't shadow
  // the injected `standup: AiStandupService` field above (TS2300 dup ident).
  generateStandup(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.sync.generateStandup(actor, userId);
  }

  @Post('tasks/:taskId/suggest-priority')
  suggestPriority(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.sync.suggestPriority(actor, taskId);
  }

  // ---------- Async (queue) endpoints — fire-and-forget ----------

  @Post('tasks/:taskId/embed')
  async reEmbed(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { projectId: true } });
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');
    await this.embedQueue.add('embed', { taskId });
    return { queued: true };
  }

  @Post('tasks/:taskId/detect-duplicates')
  async detectDup(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { projectId: true } });
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');
    await this.dupQueue.add('detect', { taskId });
    return { queued: true };
  }

  @Post('sprints/:sprintId/summarize')
  async summarizeSprint(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sprintId', new ParseUUIDPipe()) sprintId: string,
  ) {
    const sprint = await this.prisma.sprint.findUniqueOrThrow({ where: { id: sprintId }, select: { projectId: true } });
    const role = await this.permissions.effectiveRole(actor, sprint.projectId);
    if (role !== 'Manager' && !(actor.kind === 'internal' && actor.companyRole === 'Admin')) {
      throw new ForbiddenException('Manager only');
    }
    await this.sumQueue.add('summarize-sprint', { kind: 'sprint', sprintId });
    return { queued: true };
  }

  // ---------- Standup synthesis (structured, with citations) ----------
  //
  // Returns `{ did, doing, blockers }` where each bullet carries the IDs of
  // the source tasks/comments it was drawn from. Falls back to an empty
  // result when the feature toggle is off or the workspace is over its
  // monthly budget; either way the response shape is stable.

  @Post('users/:userId/standup-synthesis')
  async standupSynthesis(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60_000);
    return this.standup.synthesize(actor, userId, since, now);
  }

  // ---------- Sprint planning ----------
  //
  // Two endpoints: capacity recommendation (read-only, no LLM) and ranked
  // task list (also read-only, deterministic math). The "Plan with AI" modal
  // on the backlog page calls both back-to-back.

  @Get('projects/:projectId/sprint-capacity')
  capacity(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.sprintPlanning.suggestSprintCapacity(actor, projectId);
  }

  @Post('projects/:projectId/plan-sprint')
  async planSprint(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: { capacity?: number } | undefined,
  ) {
    const capacityInput = Number(body?.capacity);
    let capacity = Number.isFinite(capacityInput) && capacityInput > 0 ? capacityInput : 0;
    if (!capacity) {
      const recommendation = await this.sprintPlanning.suggestSprintCapacity(actor, projectId);
      capacity = recommendation.suggestedPoints;
    }
    const ranked = await this.sprintPlanning.suggestTasksForSprint(actor, projectId, capacity);
    return ranked;
  }

  // ---------- Cost telemetry ----------
  //
  // Read-only daily breakdown for the "Usage & cost" section of the AI
  // settings tab. Bounded windows only — callers pass `?days=N` (default 30,
  // capped at 90 to keep the SQL hit small).

  @Get('usage/summary')
  async usageSummary(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('days') daysRaw?: string,
  ) {
    if (actor.kind !== 'internal') throw new ForbiddenException('Internal only');
    const days = clampDays(Number(daysRaw ?? 30));
    const until = new Date();
    const since = new Date(until.getTime() - days * 24 * 60 * 60_000);
    return this.costs.summary({ since, until });
  }
}

function clampDays(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(90, Math.max(1, Math.floor(n)));
}
