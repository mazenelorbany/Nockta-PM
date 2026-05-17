import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean, IsEnum, IsObject, IsOptional, IsString, MaxLength, MinLength,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { AutomationsService, type AutomationInput } from './automations.service';

const TRIGGERS = [
  'task_created', 'task_status_changed', 'task_assigned', 'task_unassigned',
  'task_due_soon', 'task_blocked', 'task_labeled', 'comment_added',
] as const;
const ACTIONS = [
  'set_priority', 'set_assignee', 'add_label', 'remove_label',
  'transition_status', 'add_comment', 'add_watcher', 'notify_user',
  'set_due_date', 'set_sprint',
] as const;

class CreateAutomationDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsEnum(TRIGGERS) trigger!: (typeof TRIGGERS)[number];
  @IsOptional() @IsObject() triggerConfig?: Record<string, unknown>;
  @IsEnum(ACTIONS) action!: (typeof ACTIONS)[number];
  @IsOptional() @IsObject() actionConfig?: Record<string, unknown>;
}

class UpdateAutomationDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsEnum(TRIGGERS) trigger?: (typeof TRIGGERS)[number];
  @IsOptional() @IsObject() triggerConfig?: Record<string, unknown>;
  @IsOptional() @IsEnum(ACTIONS) action?: (typeof ACTIONS)[number];
  @IsOptional() @IsObject() actionConfig?: Record<string, unknown>;
}

class ToggleDto {
  @IsBoolean() enabled!: boolean;
}

@ApiTags('automations')
@ApiBearerAuth()
@Controller()
export class AutomationsController {
  constructor(private readonly svc: AutomationsService) {}

  @Get('projects/:projectId/automations')
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.svc.listForProject(actor, projectId);
  }

  @Post('projects/:projectId/automations')
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: CreateAutomationDto,
  ) {
    return this.svc.create(actor, projectId, dto as AutomationInput);
  }

  @Get('automations/:id')
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.get(actor, id);
  }

  @Patch('automations/:id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAutomationDto,
  ) {
    return this.svc.update(actor, id, dto as Partial<AutomationInput>);
  }

  @Patch('automations/:id/toggle')
  toggle(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ToggleDto,
  ) {
    return this.svc.toggle(actor, id, dto.enabled);
  }

  @Delete('automations/:id')
  remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.remove(actor, id);
  }

  @Get('automations/:id/runs')
  runs(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.listRuns(actor, id);
  }

  // ---- Multi-step actions ----

  @Get('automations/:id/steps')
  listSteps(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.listSteps(actor, id);
  }

  @Post('automations/:id/steps')
  addStep(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { action: (typeof ACTIONS)[number]; actionConfig?: Record<string, unknown> },
  ) {
    return this.svc.addStep(actor, id, body);
  }

  @Delete('automation-steps/:stepId')
  removeStep(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('stepId', new ParseUUIDPipe()) stepId: string,
  ) {
    return this.svc.removeStep(actor, stepId);
  }
}
