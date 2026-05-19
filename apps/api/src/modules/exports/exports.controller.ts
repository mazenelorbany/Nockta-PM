import { createReadStream, statSync } from 'node:fs';

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Response } from 'express';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { PrismaService } from '../../prisma/prisma.service';

import {
  ExportsService} from './exports.service';
import {
  type ExportDeliveryKind,
  type ExportKind,
  type ExportSourceKind,
} from './exports.service';
import { LOCAL_EXPORT_DIR } from './exports.processor';

// =============================================================================
// /exports
//
// CRUD over ExportSchedule + on-demand runs + signed-URL retrieval + the dev
// local-disk download route.
// =============================================================================

class CreateScheduleDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsIn(['csv', 'xlsx', 'pdf']) kind!: ExportKind;
  @IsIn(['saved_view', 'project', 'all_tasks']) sourceKind!: ExportSourceKind;
  @IsOptional() @IsString() sourceId?: string;
  @IsOptional() @IsString() @MaxLength(120) scheduleCron?: string | null;
  @IsIn(['download', 'email']) deliveryKind!: ExportDeliveryKind;
  @IsOptional() @IsEmail() deliveryEmail?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class UpdateScheduleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsIn(['csv', 'xlsx', 'pdf']) kind?: ExportKind;
  @IsOptional() @IsIn(['saved_view', 'project', 'all_tasks']) sourceKind?: ExportSourceKind;
  @IsOptional() @IsString() sourceId?: string | null;
  @IsOptional() @IsString() @MaxLength(120) scheduleCron?: string | null;
  @IsOptional() @IsIn(['download', 'email']) deliveryKind?: ExportDeliveryKind;
  @IsOptional() @IsEmail() deliveryEmail?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class RunInlineDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsIn(['csv', 'xlsx', 'pdf']) kind!: ExportKind;
  @IsIn(['saved_view', 'project', 'all_tasks']) sourceKind!: ExportSourceKind;
  @IsOptional() @IsString() sourceId?: string;
}

class RecentRunsQuery {
  @IsOptional() @IsString() scheduleId?: string;
  @IsOptional() @IsInt() @Min(1) take?: number;
}

@ApiTags('exports')
@ApiBearerAuth()
@Controller('exports')
export class ExportsController {
  constructor(
    private readonly svc: ExportsService,
    private readonly prisma: PrismaService,
  ) {}

  // ---- schedules ----------------------------------------------------------

  @Get('schedules')
  listSchedules(@CurrentUser() actor: AuthenticatedUser) {
    return this.svc.listSchedules(actor);
  }

  @Post('schedules')
  createSchedule(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateScheduleDto,
  ) {
    return this.svc.createSchedule(actor, dto);
  }

  @Get('schedules/:id')
  getSchedule(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.getSchedule(actor, id);
  }

  @Patch('schedules/:id')
  updateSchedule(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateScheduleDto,
  ) {
    return this.svc.updateSchedule(actor, id, dto);
  }

  @Delete('schedules/:id')
  deleteSchedule(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.deleteSchedule(actor, id);
  }

  // ---- runs ---------------------------------------------------------------

  @Post('schedules/:id/run')
  runSchedule(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.runOnce(actor, { scheduleId: id });
  }

  /**
   * Inline export — caller supplies the params and skips persisting a
   * schedule. Used by the "export this view now" button on a board page.
   */
  @Post('run')
  runInline(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: RunInlineDto,
  ) {
    return this.svc.runOnce(actor, { inline: dto });
  }

  @Get('runs')
  listRuns(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: RecentRunsQuery,
  ) {
    return this.svc.listRecentRuns(actor, {
      ...(query.scheduleId ? { scheduleId: query.scheduleId } : {}),
      ...(query.take ? { take: query.take } : {}),
    });
  }

  @Get('runs/:id/url')
  getDownloadUrl(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.getDownloadUrl(actor, id);
  }

  /**
   * Local-disk fallback used by dev stacks without S3 configured. Production
   * deployments serve the signed URL directly from S3 and never hit this
   * route. The processor writes the file to LOCAL_EXPORT_DIR/<runId> and
   * stamps an internal /exports/:runId/download URL on the run so the
   * frontend has a stable link.
   */
  @Get(':runId/download')
  async downloadLocal(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Res() res: Response,
  ): Promise<void> {
    const run = await this.prisma.exportRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Export run not found');
    if (run.status !== 'completed' || !run.storageKey) {
      throw new BadRequestException('Run is not downloadable');
    }
    // Ownership: re-use the service's guard via getDownloadUrl-shaped check.
    // (Throws 404 if the run is in another workspace.)
    await this.svc.getDownloadUrl(actor, runId);

    // storageKey for the local path is `local:<absolute or relative path>`
    // so we don't accidentally serve an S3 key as a local file. Reject
    // anything that doesn't carry the prefix — the S3 deploy path doesn't
    // hit this route at all.
    if (!run.storageKey.startsWith('local:')) {
      throw new BadRequestException('Run is stored remotely — use the signed URL');
    }
    const localPath = run.storageKey.slice('local:'.length);
    // Defence in depth — only serve files under LOCAL_EXPORT_DIR.
    if (!localPath.startsWith(LOCAL_EXPORT_DIR)) {
      throw new BadRequestException('Refusing to serve file outside export dir');
    }
    let stats;
    try {
      stats = statSync(localPath);
    } catch {
      throw new NotFoundException('Export file no longer on disk');
    }
    const contentType = contentTypeFor(run.kind);
    const filename = filenameFor(run.id, run.kind);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    createReadStream(localPath).pipe(res);
  }
}

function contentTypeFor(kind: string): string {
  if (kind === 'csv') return 'text/csv; charset=utf-8';
  if (kind === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (kind === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function filenameFor(runId: string, kind: string): string {
  const ext = kind === 'csv' ? 'csv' : kind === 'xlsx' ? 'xlsx' : kind === 'pdf' ? 'pdf' : 'bin';
  return `export-${runId.slice(0, 8)}.${ext}`;
}
