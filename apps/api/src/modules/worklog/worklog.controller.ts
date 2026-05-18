import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import type { WorklogService } from './worklog.service';

class StartTimerDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class LogManualDto {
  @IsInt() @Min(1) seconds!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

@ApiTags('worklog')
@ApiBearerAuth()
@Controller()
export class WorklogController {
  constructor(private readonly worklog: WorklogService) {}

  @Get('tasks/:taskId/worklog')
  listForTask(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.worklog.listForTask(actor, taskId);
  }

  @Post('tasks/:taskId/worklog/start')
  start(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body() dto: StartTimerDto,
  ) {
    return this.worklog.start(actor, taskId, dto.note);
  }

  @Post('tasks/:taskId/worklog/stop')
  stop(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.worklog.stop(actor, taskId);
  }

  @Post('tasks/:taskId/worklog/log')
  log(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body() dto: LogManualDto,
  ) {
    return this.worklog.logManual(actor, taskId, dto);
  }

  @Delete('worklog/:id')
  remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.worklog.delete(actor, id);
  }

  @Get('worklog/active')
  active(@CurrentUser() actor: AuthenticatedUser) {
    return this.worklog.listActive(actor);
  }

  /**
   * Hydrate the timer chip on app load. Returns the user's currently-running
   * worklog row (if any) plus the task's display key/title so the UI can
   * render the in-progress state without a follow-up /tasks/:id request.
   */
  @Get('worklog/me/active')
  myActive(@CurrentUser() actor: AuthenticatedUser) {
    return this.worklog.getMyActive(actor);
  }
}
