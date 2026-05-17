import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Priority, TaskLinkType, TaskType, Visibility } from '@prisma/client';
import {
  IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString,
  IsUUID, MaxLength, Min, MinLength,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { TasksService } from './tasks.service';

class CreateTaskDto {
  @IsUUID() projectId!: string;
  @IsOptional() @IsEnum(TaskType) type?: TaskType;
  @IsString() @MinLength(1) @MaxLength(300) title!: string;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsOptional() @IsEnum(Priority) priority?: Priority;
  @IsOptional() @IsEnum(Visibility) visibility?: Visibility;
  @IsOptional() @IsUUID() parentTaskId?: string;
  @IsOptional() @IsUUID() sprintId?: string;
  @IsOptional() @IsUUID() assigneeUserId?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsInt() @Min(0) estimate?: number;
}

class UpdateTaskDto {
  @IsOptional() @IsEnum(TaskType) type?: TaskType;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) title?: string;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsOptional() @IsEnum(Priority) priority?: Priority;
  @IsOptional() @IsEnum(Visibility) visibility?: Visibility;
  @IsOptional() @IsUUID() parentTaskId?: string | null;
  @IsOptional() @IsUUID() sprintId?: string | null;
  @IsOptional() @IsUUID() assigneeUserId?: string | null;
  @IsOptional() @IsUUID() reporterUserId?: string;
  @IsOptional() @IsDateString() startDate?: string | null;
  @IsOptional() @IsDateString() dueDate?: string | null;
  @IsOptional() @IsInt() @Min(0) estimate?: number | null;
  @IsOptional() @IsString() blockedReason?: string | null;
}

class ChangeStatusDto {
  @IsString() status!: string;
}

class SetBlockedDto {
  // Body is parsed as JSON so `blocked` is already a real boolean; no need to
  // run `@Type(() => Boolean)` which would coerce the string "false" to true.
  @IsBoolean() blocked!: boolean;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class ReorderDto {
  @IsOptional() @IsString() before?: string | null;
  @IsOptional() @IsString() after?: string | null;
}

class CreateLinkDto {
  @IsUUID() toTaskId!: string;
  @IsEnum(TaskLinkType) type!: TaskLinkType;
}

@ApiTags('tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateTaskDto) {
    const { dueDate, ...rest } = dto;
    return this.tasks.create(actor, {
      ...rest,
      ...(dueDate ? { dueDate: new Date(dueDate) } : {}),
    });
  }

  @Get('project/:projectId')
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('status') status?: string,
    @Query('assigneeUserId') assigneeUserId?: string,
    @Query('sprintId') sprintId?: string,
    @Query('isBlocked') isBlocked?: string,
    @Query('parentTaskId') parentTaskId?: string,
    @Query('type') type?: TaskType,
  ) {
    return this.tasks.listByProject(actor, projectId, {
      ...(status ? { status } : {}),
      ...(assigneeUserId ? { assigneeUserId } : {}),
      ...(sprintId ? { sprintId } : {}),
      ...(isBlocked !== undefined ? { isBlocked: isBlocked === 'true' } : {}),
      ...(parentTaskId !== undefined ? { parentTaskId: parentTaskId === 'null' ? null : parentTaskId } : {}),
      ...(type ? { type } : {}),
    });
  }

  @Get(':id')
  get(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.tasks.get(actor, id);
  }

  /**
   * Dependency-graph endpoint for the TaskDependencyGraph SVG widget
   * (Pass 5 R4-deferred C). `depth` defaults to 2 hops in each direction;
   * clamped server-side to [0..4] to keep the SVG render tractable.
   */
  @Get(':id/graph')
  graph(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('depth') depth?: string,
  ) {
    const parsed = depth ? Number(depth) : 2;
    return this.tasks.getDependencyGraph(actor, id, Number.isFinite(parsed) ? parsed : 2);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    const { dueDate, startDate, ...rest } = dto;
    return this.tasks.update(actor, id, {
      ...rest,
      ...(dueDate !== undefined
        ? { dueDate: dueDate === null ? null : new Date(dueDate) }
        : {}),
      ...(startDate !== undefined
        ? { startDate: startDate === null ? null : new Date(startDate) }
        : {}),
    });
  }

  @Delete(':id')
  remove(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.tasks.remove(actor, id);
  }

  @Patch(':id/status')
  changeStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ChangeStatusDto,
  ) {
    return this.tasks.changeStatus(actor, id, dto.status, 'user');
  }

  @Patch(':id/blocked')
  setBlocked(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetBlockedDto,
  ) {
    return this.tasks.setBlocked(actor, id, dto.blocked, dto.reason);
  }

  @Patch(':id/reorder')
  reorder(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReorderDto,
  ) {
    return this.tasks.reorderOnBoard(actor, id, dto.before ?? null, dto.after ?? null);
  }

  @Post(':id/watch')
  watch(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.tasks.watch(actor, id);
  }

  @Delete(':id/watch')
  unwatch(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.tasks.unwatch(actor, id);
  }

  @Post(':id/mute')
  mute(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.tasks.mute(actor, id);
  }

  @Delete(':id/mute')
  unmute(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.tasks.unmute(actor, id);
  }

  // ---- Co-reporters (multi-reporter chip row in the drawer) ----

  @Get(':id/reporters')
  listReporters(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.tasks.listReporters(actor, id);
  }

  @Post(':id/reporters/:userId')
  addReporter(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.tasks.addReporter(actor, id, userId);
  }

  @Delete(':id/reporters/:userId')
  removeReporter(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.tasks.removeReporter(actor, id, userId);
  }

  @Post(':id/links')
  link(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateLinkDto,
  ) {
    return this.tasks.createLink(actor, id, dto.toTaskId, dto.type);
  }

  @Delete('links/:linkId')
  unlink(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('linkId', new ParseUUIDPipe()) linkId: string,
  ) {
    return this.tasks.deleteLink(actor, linkId);
  }
}
