import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AttachmentParentType, Visibility } from '@prisma/client';
import {
  IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { AttachmentsService } from './attachments.service';

class SignUploadDto {
  @IsEnum(AttachmentParentType) parentType!: AttachmentParentType;
  @IsUUID() parentId!: string;
  @IsString() @MinLength(1) @MaxLength(255) filename!: string;
  @IsString() @MinLength(1) @MaxLength(255) mimeType!: string;
  @IsInt() @Min(1) @Max(500 * 1024 * 1024) size!: number;
}

class ConfirmUploadDto {
  @IsUUID() uploadId!: string;
  @IsString() storageKey!: string;
  @IsEnum(AttachmentParentType) parentType!: AttachmentParentType;
  @IsUUID() parentId!: string;
  @IsString() @MinLength(1) @MaxLength(255) originalFilename!: string;
  @IsString() @MinLength(1) @MaxLength(255) mimeType!: string;
  @IsInt() @Min(1) @Max(500 * 1024 * 1024) sizeBytes!: number;
  @IsOptional() @IsEnum(Visibility) visibility?: Visibility;
}

@ApiTags('attachments')
@ApiBearerAuth()
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post('sign')
  sign(@CurrentUser() actor: AuthenticatedUser, @Body() dto: SignUploadDto) {
    return this.attachments.sign(actor, dto);
  }

  @Post('confirm')
  confirm(@CurrentUser() actor: AuthenticatedUser, @Body() dto: ConfirmUploadDto) {
    return this.attachments.confirm(actor, dto);
  }

  @Get(':id/download')
  download(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.attachments.getDownloadUrl(actor, id);
  }

  /**
   * Inline-image redirect target for `attachment:<id>` markers rewritten by
   * CommentsService. Issues a fresh signed-GET on every hit so links survive
   * the 15-minute MinIO TTL.
   */
  @Get(':id/inline')
  async inline(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { url } = await this.attachments.getDownloadUrl(actor, id);
    res.redirect(302, url);
  }

  @Get()
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('parentType') parentType: AttachmentParentType,
    @Query('parentId', new ParseUUIDPipe()) parentId: string,
  ) {
    return this.attachments.list(actor, parentType, parentId);
  }

  @Delete(':id')
  delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.attachments.softDelete(actor, id);
  }
}
