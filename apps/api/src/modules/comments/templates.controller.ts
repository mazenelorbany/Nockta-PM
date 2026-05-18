import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import type { CommentTemplatesService } from './templates.service';

class CreateTemplateDto {
  @IsString() @MaxLength(80) name!: string;
  @IsString() @MaxLength(4000) body!: string;
  @IsOptional() @IsUUID() projectId?: string | null;
}

class UpdateTemplateDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(4000) body?: string;
}

/**
 * Pass I (Comments 8 → 9) — Reusable comment templates.
 *
 * GET    /comment-templates?projectId=...  — workspace + (optional) scoped list
 * POST   /comment-templates                — Admin (workspace) or Manager (project)
 * PATCH  /comment-templates/:id            — same as POST per scope
 * DELETE /comment-templates/:id            — same as POST per scope
 */
@ApiTags('comment-templates')
@ApiBearerAuth()
@Controller('comment-templates')
export class CommentTemplatesController {
  constructor(private readonly templates: CommentTemplatesService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('projectId') projectId?: string,
  ) {
    return this.templates.list(actor, projectId ?? null);
  }

  @Post()
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateTemplateDto,
  ) {
    return this.templates.create(actor, {
      name: dto.name,
      body: dto.body,
      projectId: dto.projectId ?? null,
    });
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templates.update(actor, id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
    });
  }

  @Delete(':id')
  async delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.templates.delete(actor, id);
    return { ok: true };
  }
}
