import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put,
  Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AttachmentParentType, Visibility } from '@prisma/client';
import {
  IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength,
} from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { StorageService } from '../storage/storage.service';

import { AttachmentsService } from './attachments.service';

// Hard cap on disk-backend body size. Matches MAX_FILE_BYTES_HARD in
// AttachmentsService — the sign step already enforces it against the
// declared size; this is the streaming guard against a malicious client
// that signs a small file then tries to PUT a much bigger one.
const DISK_MAX_BODY_BYTES = 500 * 1024 * 1024;

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
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly storage: StorageService,
  ) {}

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

  // ---------------------------------------------------------------------------
  // Disk-backend blob routes
  //
  // When STORAGE_KIND=disk, AttachmentsService.sign() returns API-self URLs
  // pointing at PUT /attachments/_blob/:token (and signedGetUrl points at
  // GET …/:token). The token is an HMAC of {storageKey, op, exp} signed
  // with JWT_ACCESS_SECRET — it IS the auth for these routes, so they
  // bypass the bearer JwtAuthGuard via @Public(). Token verification +
  // path-traversal protection live in StorageService.
  //
  // These routes do nothing useful on the s3 backend — they're not wired
  // by signedPutUrl in that mode — but stay registered unconditionally so
  // a deploy can switch backends without restarting the controller graph.
  // ---------------------------------------------------------------------------

  @Public()
  @Put('_blob/:token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async diskBlobUpload(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const payload = this.storage.verifyDiskToken(token, 'put');
    const path = this.storage.diskPath(payload.k);
    await mkdir(dirname(path), { recursive: true });

    // Stream the body to disk with a hard byte-cap guard. We can't rely on
    // Content-Length since clients can lie — the cap is enforced by
    // counting actual bytes written.
    let bytes = 0;
    let aborted = false;
    const writer = createWriteStream(path);
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > DISK_MAX_BODY_BYTES) {
        aborted = true;
        req.destroy();
        writer.destroy();
      }
    });
    try {
      await pipeline(req, writer);
    } catch (err) {
      if (aborted) {
        res.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
          statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
          error: 'Payload Too Large',
          message: `Body exceeded ${DISK_MAX_BODY_BYTES} bytes`,
        });
        return;
      }
      throw err;
    }
    res.status(HttpStatus.NO_CONTENT).end();
  }

  @Public()
  @Get('_blob/:token')
  async diskBlobDownload(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const payload = this.storage.verifyDiskToken(token, 'get');
    const path = this.storage.diskPath(payload.k);
    let size = 0;
    try {
      const st = await stat(path);
      size = st.size;
    } catch {
      res.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        message: 'Object not found',
      });
      return;
    }
    // Browsers ignore Content-Disposition on inline images, so the route
    // doubles as the redirect target for `/attachments/:id/inline`. The
    // real filename is on the Attachment row; if a future caller wants
    // download-as-name we can have AttachmentsService set a query param
    // on the signed URL and echo it back as Content-Disposition here.
    res.setHeader('content-length', String(size));
    res.setHeader('cache-control', 'private, max-age=0, must-revalidate');
    await pipeline(createReadStream(path), res);
  }
}
