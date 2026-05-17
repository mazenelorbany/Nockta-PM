import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { DocsService } from './docs.service';
import type { ProseMirrorDoc } from './prosemirror-markdown';

class CreateDocDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(500_000) body?: string;
  // ProseMirror JSON tree from the Tiptap editor. We don't validate the
  // internal structure here — the service trusts what comes in and derives
  // markdown from it. The shape is enforced at the editor schema level on
  // the client and (defensively) by the serializer's tolerant traversal.
  @IsOptional() @IsObject() contentJson?: ProseMirrorDoc;
  @IsOptional() @IsUUID() parentDocId?: string;
}

class UpdateDocDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(500_000) body?: string;
  @IsOptional() @IsObject() contentJson?: ProseMirrorDoc;
  @IsOptional() @IsUUID() parentDocId?: string | null;
  @IsOptional() @IsInt() @Min(0) position?: number;
}

// AddDocCommentDto must be declared before the controller — parameter
// decorators run at class-definition time and resolve the type token
// against the lexical scope at that point. Declaring it after the controller
// triggers the temporal-dead-zone "Cannot access … before initialization".
class AddDocCommentDto {
  @IsString() @MinLength(1) @MaxLength(10_000) body!: string;
  @IsOptional() @IsUUID() parentCommentId?: string;
}

@ApiTags('docs')
@ApiBearerAuth()
@Controller()
export class DocsController {
  constructor(private readonly docs: DocsService) {}

  @Get('projects/:projectId/docs')
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.docs.listForProject(actor, projectId);
  }

  @Post('projects/:projectId/docs')
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: CreateDocDto,
  ) {
    return this.docs.create(actor, projectId, dto);
  }

  @Get('docs/:id')
  get(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.docs.get(actor, id);
  }

  @Patch('docs/:id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDocDto,
  ) {
    return this.docs.update(actor, id, dto);
  }

  @Delete('docs/:id')
  archive(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.docs.archive(actor, id);
  }

  @Get('docs/:id/revisions')
  revisions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.docs.listRevisions(actor, id);
  }

  @Post('docs/:id/revisions/:revisionId/restore')
  restore(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('revisionId', new ParseUUIDPipe()) revisionId: string,
  ) {
    return this.docs.restoreRevision(actor, id, revisionId);
  }

  // ---- Doc ↔ Task linking ----

  @Get('tasks/:taskId/docs')
  listDocsForTask(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.docs.listDocsForTask(actor, taskId);
  }

  @Get('docs/:docId/tasks')
  listTasksForDoc(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('docId', new ParseUUIDPipe()) docId: string,
  ) {
    return this.docs.listTasksForDoc(actor, docId);
  }

  @Post('docs/:docId/tasks/:taskId')
  linkTask(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('docId', new ParseUUIDPipe()) docId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.docs.linkTaskToDoc(actor, docId, taskId);
  }

  @Delete('docs/:docId/tasks/:taskId')
  unlinkTask(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('docId', new ParseUUIDPipe()) docId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.docs.unlinkTaskFromDoc(actor, docId, taskId);
  }

  // ---- Doc comments ----

  @Get('docs/:docId/comments')
  listComments(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('docId', new ParseUUIDPipe()) docId: string,
  ) {
    return this.docs.listComments(actor, docId);
  }

  @Post('docs/:docId/comments')
  addComment(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('docId', new ParseUUIDPipe()) docId: string,
    @Body() dto: AddDocCommentDto,
  ) {
    return this.docs.addComment(actor, docId, dto.body, dto.parentCommentId);
  }

  @Delete('doc-comments/:id')
  deleteComment(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.docs.deleteComment(actor, id);
  }
}
