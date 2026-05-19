import { randomUUID } from 'node:crypto';

import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import { SprintRetroService } from './retro.service';
import { SprintsService } from './sprints.service';

class CreateSprintDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  /// Free-text sprint goal / theme. Caps at 200 chars at the service layer
  /// (the @MaxLength below mirrors that so client-side validation is fast).
  @IsOptional() @IsString() @MaxLength(200) goal?: string;
}

class UpdateSprintDto {
  /// Null clears the goal; empty string is treated as null.
  @IsOptional() @IsString() @MaxLength(200) goal?: string | null;
}

class CompleteSprintDto {
  @IsOptional() @IsEnum(['backlog', 'next_planned_sprint'])
  moveIncompleteTo?: 'backlog' | 'next_planned_sprint';
}

class AddTasksDto {
  @IsArray() @ArrayMinSize(1) @IsUUID('all', { each: true })
  taskIds!: string[];
}

class ActionItemDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @MaxLength(500) description!: string;
  @IsOptional() @IsUUID() ownerUserId?: string | null;
  @IsIn(['open', 'done']) status!: 'open' | 'done';
  @IsOptional() @IsString() dueDate?: string | null;
}

class CreateRetroDto {
  @IsOptional() @IsString() @MaxLength(5000) whatWentWell?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) whatCouldImprove?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ActionItemDto)
  actionItems?: ActionItemDto[];
}

class EvaluateGoalDto {
  @IsBoolean() goalAchieved!: boolean;
  @IsOptional() @IsString() @MaxLength(2000) note?: string | null;
}

@ApiTags('sprints')
@ApiBearerAuth()
@Controller()
export class SprintsController {
  constructor(
    private readonly sprints: SprintsService,
    private readonly retros: SprintRetroService,
  ) {}

  @Get('projects/:projectId/sprints')
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.sprints.listByProject(actor, projectId);
  }

  @Post('projects/:projectId/sprints')
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: CreateSprintDto,
  ) {
    return this.sprints.create(actor, projectId, {
      name: dto.name,
      ...(dto.startDate ? { startDate: new Date(dto.startDate) } : {}),
      ...(dto.endDate ? { endDate: new Date(dto.endDate) } : {}),
      ...(dto.goal !== undefined ? { goal: dto.goal } : {}),
    });
  }

  @Get('sprints/:id')
  get(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.sprints.get(actor, id);
  }

  /**
   * PATCH /sprints/:id — currently scoped to the `goal` field only. Kept as a
   * dedicated endpoint (rather than rolling into start/complete) so editing the
   * theme of an in-flight sprint doesn't accidentally flip its state machine.
   */
  @Patch('sprints/:id')
  updateMetadata(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSprintDto,
  ) {
    return this.sprints.updateMetadata(actor, id, {
      ...(dto.goal !== undefined ? { goal: dto.goal } : {}),
    });
  }

  @Post('sprints/:id/start')
  start(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.sprints.start(actor, id);
  }

  @Post('sprints/:id/complete')
  complete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CompleteSprintDto,
  ) {
    return this.sprints.complete(actor, id, dto);
  }

  @Delete('sprints/:id')
  delete(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.sprints.delete(actor, id);
  }

  // ---- Planning endpoints ----

  @Get('projects/:projectId/backlog')
  backlog(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.sprints.listBacklog(actor, projectId);
  }

  @Get('sprints/:id/tasks')
  tasksInSprint(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.sprints.listTasksInSprint(actor, id);
  }

  @Post('sprints/:id/tasks')
  addTasks(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddTasksDto,
  ) {
    return this.sprints.addTasks(actor, id, dto.taskIds);
  }

  @Delete('sprints/:id/tasks/:taskId')
  removeTask(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.sprints.removeTask(actor, id, taskId);
  }

  // ---- Retro + goal evaluation (Pass I — Sprints 8→9) -------------------

  /**
   * Upsert the retrospective for a sprint. One row per sprint; calling twice
   * is a deliberate update, not a 409. The "Run retro" button on the backlog
   * page hits this endpoint.
   */
  @Post('sprints/:id/retro')
  createRetro(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateRetroDto,
  ) {
    return this.retros.createRetro(actor, id, {
      whatWentWell: dto.whatWentWell ?? null,
      whatCouldImprove: dto.whatCouldImprove ?? null,
      actionItems: (dto.actionItems ?? []).map((it) => ({
        id: it.id ?? randomUUID(),
        description: it.description,
        ownerUserId: it.ownerUserId ?? null,
        status: it.status,
        dueDate: it.dueDate ?? null,
      })),
    });
  }

  @Get('sprints/:id/retro')
  getRetro(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.retros.getRetro(actor, id);
  }

  /**
   * Cross-sprint action-items panel for a project. Supports `?status=open`
   * or `?status=done` filtering — omit for both.
   */
  @Get('projects/:projectId/action-items')
  listActionItems(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('status') status?: 'open' | 'done',
  ) {
    return this.retros.listActionItems(actor, projectId, status ? { status } : {});
  }

  @Post('sprints/:id/goal-evaluation')
  evaluateGoal(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: EvaluateGoalDto,
  ) {
    return this.retros.evaluateGoal(actor, id, {
      goalAchieved: dto.goalAchieved,
      note: dto.note ?? null,
    });
  }

  @Get('sprints/:id/goal-evaluation')
  getGoalEvaluation(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.retros.getGoalEvaluation(actor, id);
  }
}
