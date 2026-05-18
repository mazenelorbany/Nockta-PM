import { Body, Controller, DefaultValuePipe, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Visibility } from '@prisma/client';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import type { CommentsService } from './comments.service';
import { ALLOWED_REACTION_EMOJIS } from './comments.service';

class CreateCommentDto {
  @IsString() @MinLength(1) @MaxLength(10_000) body!: string;
  @IsOptional() @IsEnum(Visibility) visibility?: Visibility;
  /** Reply to another comment. Replies are flat (no nested replies). */
  @IsOptional() @IsUUID() parentCommentId?: string;
  /**
   * Optional quoted-selection metadata. All three fields are required together
   * — the controller validates the triple is present-or-absent atomically so
   * we don't end up with a half-populated quote.
   */
  @IsOptional() @IsUUID() quotedCommentId?: string;
  @ValidateIf((o: CreateCommentDto) => o.quotedCommentId !== undefined)
  @IsInt() @Min(0) quotedRangeStart?: number;
  @ValidateIf((o: CreateCommentDto) => o.quotedCommentId !== undefined)
  @IsInt() @Min(0) quotedRangeEnd?: number;
}

class UpdateCommentDto {
  @IsString() @MinLength(1) @MaxLength(10_000) body!: string;
}

class ReactionDto {
  @IsString()
  @IsIn(ALLOWED_REACTION_EMOJIS as readonly string[] as string[])
  emoji!: string;
}

@ApiTags('comments')
@ApiBearerAuth()
@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('tasks/:taskId/comments')
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.comments.listByTask(actor, taskId);
  }

  /**
   * Recent comments across a project — drives the client portal's "Project
   * discussion" pane and is reachable to internal users too if they ever
   * want a project-level activity surface. Visibility is enforced server-side
   * per-row so clients only see client_visible comments.
   */
  @Get('projects/:projectId/comments/recent')
  listRecentForProject(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.comments.listRecentForProject(actor, projectId, limit);
  }

  @Post('tasks/:taskId/comments')
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body() dto: CreateCommentDto,
  ) {
    const quoted =
      dto.quotedCommentId !== undefined &&
      dto.quotedRangeStart !== undefined &&
      dto.quotedRangeEnd !== undefined
        ? {
            commentId: dto.quotedCommentId,
            rangeStart: dto.quotedRangeStart,
            rangeEnd: dto.quotedRangeEnd,
          }
        : undefined;
    return this.comments.create(
      actor,
      taskId,
      dto.body,
      dto.visibility,
      dto.parentCommentId,
      quoted,
    );
  }

  @Patch('comments/:id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.comments.update(actor, id, dto.body);
  }

  @Delete('comments/:id')
  delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.comments.delete(actor, id);
  }

  @Post('comments/:id/reactions')
  addReaction(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReactionDto,
  ) {
    return this.comments.addReaction(actor, id, dto.emoji);
  }

  @Delete('comments/:id/reactions/:emoji')
  removeReaction(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('emoji') emoji: string,
  ) {
    return this.comments.removeReaction(actor, id, emoji);
  }

  @Get('comments/:id/revisions')
  listRevisions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.comments.listRevisions(actor, id);
  }
}
