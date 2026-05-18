import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Priority, TaskType } from '@prisma/client';
import {
  ArrayMaxSize, IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength,
} from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import type { TaskTemplatesService} from './task-templates.service';
import { type TaskTemplateInput } from './task-templates.service';

class CreateTaskTemplateDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsString() @MinLength(1) @MaxLength(300) titleTemplate!: string;
  @IsOptional() @IsString() @MaxLength(10_000) bodyTemplate?: string;
  @IsOptional() @IsEnum(Priority) priority?: Priority;
  @IsOptional() @IsInt() @Min(0) estimate?: number;
  @IsOptional() @IsString() defaultStatus?: string;
  @IsOptional() @IsArray() labelIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) tags?: string[];
  @IsOptional() @IsEnum(TaskType) taskType?: TaskType;
}

class UpdateTaskTemplateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) titleTemplate?: string;
  @IsOptional() @IsString() @MaxLength(10_000) bodyTemplate?: string;
  @IsOptional() @IsEnum(Priority) priority?: Priority;
  @IsOptional() @IsInt() @Min(0) estimate?: number;
  @IsOptional() @IsString() defaultStatus?: string;
  @IsOptional() @IsArray() labelIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) tags?: string[];
  @IsOptional() @IsEnum(TaskType) taskType?: TaskType;
}

class InstantiateDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsUUID() assigneeUserId?: string | null;
  @IsOptional() @IsDateString() dueDate?: string | null;
  @IsOptional() @IsUUID() sprintId?: string | null;
  /**
   * Override the destination project. By default a template instantiates into
   * its owning project, but the gallery lets a user instantiate INTO a
   * different project they have Contributor+ on. When set, the destination
   * must share the workspace and the actor must hold Contributor on it.
   */
  @IsOptional() @IsUUID() targetProjectId?: string;
}

@ApiTags('task-templates')
@ApiBearerAuth()
@Controller()
export class TaskTemplatesController {
  constructor(private readonly svc: TaskTemplatesService) {}

  /**
   * Cross-project gallery. Used by the "+ New Task" drawer to let a user pull
   * a template from ANY project they can read, not just the current one. Both
   * `type` and `tag` are optional and AND-combined.
   */
  @Get('task-templates/gallery')
  gallery(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('type') type?: string,
    @Query('tag') tag?: string,
    @Query('q') q?: string,
  ) {
    const taskType =
      type && (['Epic', 'Story', 'Task', 'Bug', 'Subtask'] as const).includes(type as TaskType)
        ? (type as TaskType)
        : undefined;
    return this.svc.listGallery(actor, {
      ...(taskType ? { type: taskType } : {}),
      ...(tag ? { tag } : {}),
      ...(q ? { q } : {}),
    });
  }

  /**
   * Distinct, in-use tags across templates the actor can see. Used by the
   * gallery filter dropdown so the option set is drawn from real data instead
   * of being hand-curated.
   */
  @Get('task-templates/tags')
  tags(@CurrentUser() actor: AuthenticatedUser) {
    return this.svc.listGalleryTags(actor);
  }

  @Get('projects/:projectId/task-templates')
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.svc.listForProject(actor, projectId);
  }

  @Post('projects/:projectId/task-templates')
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: CreateTaskTemplateDto,
  ) {
    return this.svc.create(actor, projectId, dto as TaskTemplateInput);
  }

  @Patch('task-templates/:id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTaskTemplateDto,
  ) {
    return this.svc.update(actor, id, dto as Partial<TaskTemplateInput>);
  }

  @Delete('task-templates/:id')
  remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.remove(actor, id);
  }

  @Post('task-templates/:id/instantiate')
  instantiate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: InstantiateDto,
  ) {
    return this.svc.instantiate(actor, id, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.assigneeUserId !== undefined ? { assigneeUserId: dto.assigneeUserId } : {}),
      ...(dto.dueDate !== undefined ? { dueDate: dto.dueDate } : {}),
      ...(dto.sprintId !== undefined ? { sprintId: dto.sprintId } : {}),
      ...(dto.targetProjectId !== undefined ? { targetProjectId: dto.targetProjectId } : {}),
    });
  }
}
