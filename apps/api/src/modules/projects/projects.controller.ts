import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProjectRole, ProjectVisibility, Visibility, WorkflowPreset } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import { ProjectsService } from './projects.service';
import { ProjectWorkflowService } from './project-workflow.service';

class CreateProjectDto {
  @IsString() @Matches(/^[A-Z]{2,10}$/) key!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsEnum(ProjectVisibility) visibility!: ProjectVisibility;
  @IsEnum(WorkflowPreset) workflowPreset!: WorkflowPreset;
  @IsOptional() @IsBoolean() sprintsEnabled?: boolean;
}

class UpdateProjectDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsEnum(ProjectVisibility) visibility?: ProjectVisibility;
  @IsOptional() @IsBoolean() sprintsEnabled?: boolean;
  @IsOptional() @IsBoolean() githubAutoStatus?: boolean;
  @IsOptional() @IsString() chatSpaceId?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) chatBroadcastEvents?: string[];
  /** 1..500 MB hard-capped at the DB layer; enforced in attachments.service. */
  @IsOptional() maxAttachmentMb?: number;
  /** When 'client_visible', new tasks default to client-visible AND existing
   *  guests on the project see every task regardless of the per-task flag. */
  @IsOptional() @IsEnum(Visibility) defaultTaskVisibility?: Visibility;
}

class GrantAccessDto {
  // class-validator's @IsEnum expects an enum object, not an array of literals.
  // Use @IsIn to validate string-literal unions properly.
  @IsIn(['user', 'team']) subjectKind!: 'user' | 'team';
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() teamId?: string;
  @IsEnum(ProjectRole) role!: ProjectRole;
}

class InviteGuestToProjectDto {
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsEnum(ProjectRole) role!: ProjectRole;
}

// Template DTOs are declared here (above the controller) — see docs.controller.ts
// for the same temporal-dead-zone gotcha: parameter decorators resolve the
// DTO class token at class-definition time, so the class must already exist.
class CreateProjectTemplateDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsEnum(WorkflowPreset) workflowPreset!: WorkflowPreset;
  @IsOptional() @IsBoolean() sprintsEnabled?: boolean;
  @IsOptional() @IsEnum(ProjectVisibility) visibility?: ProjectVisibility;
  @IsOptional() @IsArray() labels?: { name: string; color: string }[];
  @IsOptional() @IsArray() sampleTasks?: { title: string; description?: string; type?: string; priority?: string; status?: string }[];
}

class CreateFromTemplateDto {
  @IsUUID() templateId!: string;
  @IsString() @Matches(/^[A-Z]{2,10}$/) key!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

class WorkflowTransitionDto {
  @IsString() @MaxLength(60) fromStatus!: string;
  @IsString() @MaxLength(60) toStatus!: string;
}

class ReplaceTransitionsDto {
  // Cap the array at the cartesian-product worst case for the largest preset
  // (Design has 5 statuses → 5×5 = 25 possible edges) plus headroom for the
  // custom-status feature landing next; 100 is comfortably above and bounds
  // the worst-case payload size.
  @IsArray() @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => WorkflowTransitionDto)
  transitions!: WorkflowTransitionDto[];
}

class CreateColumnDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsOptional() @IsString() color?: string | null;
  @IsOptional() position?: number;
}

class UpdateColumnDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
}

class ReorderColumnsDto {
  @IsArray() @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  orderedIds!: string[];
}

class CreateStatusDto {
  @IsUUID() columnId!: string;
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsOptional() @IsString() color?: string | null;
  @IsOptional() @IsBoolean() isInitialStatus?: boolean;
  @IsOptional() @IsBoolean() isDoneStatus?: boolean;
  @IsOptional() position?: number;
}

class UpdateStatusDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @IsOptional() @IsUUID() columnId?: string;
  @IsOptional() @IsString() color?: string | null;
  @IsOptional() @IsBoolean() isInitialStatus?: boolean;
  @IsOptional() @IsBoolean() isDoneStatus?: boolean;
  @IsOptional() position?: number;
}

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly workflow: ProjectWorkflowService,
  ) {}

  @Get()
  list(@CurrentUser() actor: AuthenticatedUser) {
    return this.projects.listForUser(actor);
  }

  /**
   * Archived (in-grace-period) projects. Distinct from `GET /projects` which
   * filters them OUT. Admin-only; surfaced by the /settings/archived-projects
   * page so the operator can restore or watch the purge countdown.
   *
   * Path is `/projects/archived/list` rather than `/projects/archived` so it
   * doesn't collide with the `:id` parameter route below — Express resolves
   * static segments first but ParseUUIDPipe on `:id` would still 400 on the
   * literal string "archived".
   */
  @Get('archived/list')
  listArchived(@CurrentUser() actor: AuthenticatedUser) {
    return this.projects.listArchived(actor);
  }

  @Post()
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(actor, dto);
  }

  @Get(':id')
  get(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.projects.get(actor, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(actor, id, dto);
  }

  @Delete(':id')
  archive(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.projects.archive(actor, id);
  }

  /**
   * Restore an archived (in-grace-period) project. POST not PATCH because
   * the action is a state transition rather than a partial mutation; the
   * route is verbed for symmetry with `archive`.
   */
  @Post(':id/restore')
  restore(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.projects.restore(actor, id);
  }

  @Get(':id/access')
  listAccess(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.projects.listAccess(actor, id);
  }

  @Post(':id/access')
  grant(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: GrantAccessDto,
  ) {
    return this.projects.grantAccess(actor, id, dto);
  }

  // ---- Workflow transitions (allowed status edges) ----

  /**
   * List the allowed (from → to) status transitions for this project.
   * Viewer+ — the board / drawer also need to read this to grey-out
   * disallowed status options in the picker.
   */
  @Get(':id/workflow-transitions')
  listWorkflowTransitions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.projects.listWorkflowTransitions(actor, id);
  }

  /**
   * Replace the project's transition set in one shot. Manager+ only.
   * Sending an empty array effectively locks every task in its current
   * status; the UI should surface that explicitly before allowing it.
   */
  @Put(':id/workflow-transitions')
  replaceWorkflowTransitions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReplaceTransitionsDto,
  ) {
    return this.projects.replaceWorkflowTransitions(actor, id, dto.transitions);
  }

  /** Reset the project's transitions to the preset's defaults. Manager+. */
  @Post(':id/workflow-transitions/reset')
  resetWorkflowTransitions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.projects.resetWorkflowTransitions(actor, id);
  }

  // ---- Columns + statuses (custom workflow) ----

  /**
   * Snapshot of a project's columns + statuses. Powers the board column
   * strip + the workflow settings editor. Viewer+ because the board
   * reads this on every paint.
   */
  @Get(':id/workflow')
  workflowSnapshot(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.workflow.snapshot(actor, id);
  }

  /** Hard reset columns + statuses + transitions to preset defaults. Manager+. */
  @Post(':id/workflow/reset')
  resetWorkflow(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.workflow.resetToDefaults(actor, id);
  }

  // ----- columns -----

  @Post(':id/columns')
  createColumn(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateColumnDto,
  ) {
    return this.workflow.createColumn(actor, id, dto);
  }

  @Patch(':id/columns/:columnId')
  renameColumn(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('columnId', new ParseUUIDPipe()) columnId: string,
    @Body() dto: UpdateColumnDto,
  ) {
    return this.workflow.renameColumn(actor, id, columnId, dto.name);
  }

  @Put(':id/columns/order')
  reorderColumns(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReorderColumnsDto,
  ) {
    return this.workflow.reorderColumns(actor, id, dto.orderedIds);
  }

  @Delete(':id/columns/:columnId')
  deleteColumn(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('columnId', new ParseUUIDPipe()) columnId: string,
  ) {
    return this.workflow.deleteColumn(actor, id, columnId);
  }

  // ----- statuses -----

  @Post(':id/statuses')
  createStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateStatusDto,
  ) {
    return this.workflow.createStatus(actor, id, dto);
  }

  @Patch(':id/statuses/:statusId')
  updateStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('statusId', new ParseUUIDPipe()) statusId: string,
    @Body() dto: UpdateStatusDto,
  ) {
    return this.workflow.updateStatus(actor, id, statusId, dto);
  }

  @Delete(':id/statuses/:statusId')
  deleteStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('statusId', new ParseUUIDPipe()) statusId: string,
  ) {
    return this.workflow.deleteStatus(actor, id, statusId);
  }

  @Delete(':id/access/:grantId')
  revoke(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
  ) {
    return this.projects.revokeAccess(actor, id, grantId);
  }

  /**
   * Invite an external collaborator to this project. One call:
   *   1. Creates (or fetches) the User row with kind='client'.
   *   2. Grants project access at the requested role.
   *   3. Emails a 7-day invitation link with the inviter's name + project name.
   *
   * Manager-or-above on the project may invite. Rejects @nockta.com domain
   * emails — internal users sign in via Google OAuth and don't need an
   * invitation. Re-invoking with the same email is safe: re-uses the user
   * row, updates the role if it changed, and re-sends the email.
   */
  @Post(':id/invite-guest')
  inviteGuest(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: InviteGuestToProjectDto,
  ) {
    return this.projects.inviteGuest(actor, id, {
      email: dto.email,
      ...(dto.name ? { name: dto.name } : {}),
      role: dto.role,
    });
  }

  // ---- Project templates ----

  @Get('templates/list')
  listTemplates(@CurrentUser() actor: AuthenticatedUser) {
    return this.projects.listTemplates(actor);
  }

  @Post('templates')
  createTemplate(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateProjectTemplateDto) {
    return this.projects.createTemplate(actor, dto);
  }

  @Delete('templates/:id')
  deleteTemplate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.projects.deleteTemplate(actor, id);
  }

  @Post('from-template')
  createFromTemplate(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateFromTemplateDto,
  ) {
    return this.projects.createFromTemplate(actor, dto);
  }
}
