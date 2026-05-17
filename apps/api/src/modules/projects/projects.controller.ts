import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProjectRole, ProjectVisibility, Visibility, WorkflowPreset } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { ProjectsService } from './projects.service';

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

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

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

  @Delete(':id/access/:grantId')
  revoke(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
  ) {
    return this.projects.revokeAccess(actor, id, grantId);
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
