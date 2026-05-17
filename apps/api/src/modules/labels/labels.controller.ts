import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsHexadecimal, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { LabelsService } from './labels.service';

class CreateLabelDto {
  @IsString() @MinLength(1) @MaxLength(40) name!: string;
  @IsOptional() @IsHexadecimal() @Length(6, 6) color?: string;
}
class UpdateLabelDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) name?: string;
  @IsOptional() @IsHexadecimal() @Length(6, 6) color?: string;
}

@ApiTags('labels')
@ApiBearerAuth()
@Controller()
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  // ---- project-scoped ----
  @Get('projects/:projectId/labels')
  listForProject(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.labels.listForProject(actor, projectId);
  }

  @Post('projects/:projectId/labels')
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: CreateLabelDto,
  ) {
    return this.labels.create(actor, projectId, dto);
  }

  @Patch('labels/:labelId')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('labelId', new ParseUUIDPipe()) labelId: string,
    @Body() dto: UpdateLabelDto,
  ) {
    return this.labels.update(actor, labelId, dto);
  }

  @Delete('labels/:labelId')
  remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('labelId', new ParseUUIDPipe()) labelId: string,
  ) {
    return this.labels.remove(actor, labelId);
  }

  // ---- task-scoped ----
  @Get('tasks/:taskId/labels')
  listForTask(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.labels.listForTask(actor, taskId);
  }

  @Post('tasks/:taskId/labels/:labelId')
  attach(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('labelId', new ParseUUIDPipe()) labelId: string,
  ) {
    return this.labels.attach(actor, taskId, labelId);
  }

  @Delete('tasks/:taskId/labels/:labelId')
  detach(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('labelId', new ParseUUIDPipe()) labelId: string,
  ) {
    return this.labels.detach(actor, taskId, labelId);
  }
}
