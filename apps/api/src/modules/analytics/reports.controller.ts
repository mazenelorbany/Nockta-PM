import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength,
} from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import {
  CustomReportsService} from './reports.service';
import { REPORT_DIMENSIONS, REPORT_METRICS,
  type ReportDimension, type ReportMetric,
} from './reports.service';

class CreateCustomReportDto {
  @IsString() @MaxLength(120) name!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3)
  @IsIn(REPORT_DIMENSIONS, { each: true })
  dimensions!: ReportDimension[];
  @IsIn(REPORT_METRICS) metric!: ReportMetric;
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
  @IsOptional() @IsUUID() projectId?: string | null;
}

class UpdateCustomReportDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3)
  @IsIn(REPORT_DIMENSIONS, { each: true })
  dimensions?: ReportDimension[];
  @IsOptional() @IsIn(REPORT_METRICS) metric?: ReportMetric;
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
}

class PreviewReportDto extends CreateCustomReportDto {}

/**
 * Pass I (Analytics 8 → 9) — Custom Report Builder.
 *
 *   GET    /analytics/reports                    list (workspace + optional project scope)
 *   POST   /analytics/reports                    create
 *   PATCH  /analytics/reports/:id                update
 *   DELETE /analytics/reports/:id                delete
 *   GET    /analytics/reports/:id                fetch one (for the edit modal)
 *   GET    /analytics/reports/:id/run            run the saved query
 *   POST   /analytics/reports/preview            inline preview (no save)
 */
@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics/reports')
export class CustomReportsController {
  constructor(private readonly reports: CustomReportsService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('projectId') projectId?: string,
  ) {
    return this.reports.list(actor, projectId ?? null);
  }

  @Get(':id')
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.reports.get(actor, id);
  }

  @Post()
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateCustomReportDto,
  ) {
    return this.reports.createReport(actor, {
      name: dto.name,
      dimensions: dto.dimensions,
      metric: dto.metric,
      filters: dto.filters as never,
      projectId: dto.projectId ?? null,
    });
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCustomReportDto,
  ) {
    return this.reports.update(actor, id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.dimensions !== undefined ? { dimensions: dto.dimensions } : {}),
      ...(dto.metric !== undefined ? { metric: dto.metric } : {}),
      ...(dto.filters !== undefined ? { filters: dto.filters as never } : {}),
    });
  }

  @Delete(':id')
  async delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.reports.delete(actor, id);
    return { ok: true };
  }

  @Get(':id/run')
  run(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.reports.runReport(actor, id);
  }

  @Post('preview')
  preview(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: PreviewReportDto,
  ) {
    return this.reports.previewReport(actor, {
      name: dto.name,
      dimensions: dto.dimensions,
      metric: dto.metric,
      filters: dto.filters as never,
      projectId: dto.projectId ?? null,
    });
  }
}
