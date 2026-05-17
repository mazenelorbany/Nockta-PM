import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireCompanyRoles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/types';
import { GithubIssuesImportService } from './github-issues-import.service';
import { ImportRunsService } from './import-runs.service';
import { ImportService, type CommitInput } from './import.service';
import { JiraImportService } from './jira-import.service';
import { LinearImportService } from './linear-import.service';
import { fields as linearFields } from './linear/fields';
import { fields as csvFields } from './csv/fields';
import { fields as jiraCsvFields } from './jira-csv/fields';
import {
  ImportsDryRunService,
  type DryRunPayload,
} from './imports-dry-run.service';
import {
  JiraCsvImporter,
  type JiraCsvMapping,
} from './jira-csv/jira-csv.importer';

// =============================================================================
// /import — admin-only Import Center routes.
//
// Three sources share the same shape:
//   list   credentials → upstream projects/teams/repos
//   preview                → 20 rows as they'd land in Nockta
//   run                    → kicks off the run, returns { runId }
//
// Plus the CSV importer's existing /import/csv routes (parse + commit) and
// /import/runs for the runs table below the source tabs.
// =============================================================================

class ParseCsvDto {
  @IsString() @MaxLength(5_000_000) csvText!: string;
}

class CommitCsvDto {
  @IsUUID() projectId!: string;
  @IsString() @MaxLength(5_000_000) csvText!: string;
  @IsObject() mapping!: Record<number, string>;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

class LinearCredsDto {
  @IsString() @MaxLength(200) apiKey!: string;
}

class LinearPreviewDto extends LinearCredsDto {
  @IsString() teamId!: string;
  @IsOptional() @IsObject() mapping?: Record<string, unknown>;
}

class LinearRunDto extends LinearPreviewDto {
  @IsOptional() @IsObject() options?: Record<string, unknown>;
}

class JiraCredsDto {
  @IsString() @MaxLength(200) domain!: string;
  @IsString() @MaxLength(200) email!: string;
  @IsString() @MaxLength(400) apiToken!: string;
}

class JiraPreviewDto extends JiraCredsDto {
  @IsString() projectKey!: string;
  @IsOptional() @IsObject() mapping?: Record<string, unknown>;
}

class JiraRunDto extends JiraPreviewDto {
  @IsOptional() @IsObject() options?: Record<string, unknown>;
}

class GhInstallationDto {
  @IsInt() @Min(1) installationId!: number;
}

class GhPreviewDto extends GhInstallationDto {
  @IsString() owner!: string;
  @IsString() repo!: string;
  @IsOptional() @IsObject() mapping?: Record<string, unknown>;
}

class GhRunDto extends GhPreviewDto {
  @IsUUID() projectId!: string;
  @IsOptional() @IsObject() options?: Record<string, unknown>;
}

/**
 * Unified dry-run DTO. The body's `source` field decides which validator
 * runs; the rest of the payload is opaque at the controller boundary and
 * forwarded to ImportsDryRunService.dryRun(). class-validator gates the
 * envelope; the service does shape-level validation inside.
 */
class DryRunDto {
  @IsString()
  @IsIn(['csv', 'linear', 'jira-csv'])
  source!: 'csv' | 'linear' | 'jira-csv';
  /** Optional for the linear source (payload is a sample array). Required
   *  for csv / jira-csv (project access is checked). */
  @IsOptional() @IsUUID() projectId?: string;
  /** Inline CSV text — csv + jira-csv sources. Capped at ~5MB. */
  @IsOptional() @IsString() @MaxLength(5_000_000) csvText?: string;
  /** Source-specific mapping payload. Validated inside the service. */
  @IsOptional() @IsObject() mapping?: Record<string, unknown>;
  /** Linear-only: pre-fetched first 50 issues from /import/linear/preview.
   *  The dry-run path doesn't go back to Linear so the user can iterate on
   *  the mapping without burning API quota. */
  @IsOptional() sample?: unknown;
}

@ApiTags('Import')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('import')
export class ImportController {
  constructor(
    private readonly csv: ImportService,
    private readonly linear: LinearImportService,
    private readonly jira: JiraImportService,
    private readonly ghIssues: GithubIssuesImportService,
    private readonly runs: ImportRunsService,
    private readonly dry: ImportsDryRunService,
    private readonly jiraCsv: JiraCsvImporter,
  ) {}

  // -------------------------- CSV (existing) --------------------------------

  @Post('csv/parse')
  @ApiOperation({ summary: 'Tokenize a CSV and return headers + sample' })
  parse(@Body() dto: ParseCsvDto) {
    return this.csv.parse(dto.csvText);
  }

  @Post('csv/commit')
  @ApiOperation({ summary: 'Apply a mapping; preview or commit task creation' })
  commit(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CommitCsvDto) {
    const input: CommitInput = {
      projectId: dto.projectId,
      csvText: dto.csvText,
      mapping: dto.mapping as Record<number, CommitInput['mapping'][number]>,
      dryRun: Boolean(dto.dryRun),
    };
    return this.csv.commit(actor, input);
  }

  // -------------------------- Linear ----------------------------------------

  @Post('linear/teams')
  @RequireCompanyRoles('Admin')
  @ApiOperation({ summary: 'List Linear workspace teams for the supplied API key' })
  linearTeams(@Body() dto: LinearCredsDto) {
    return this.linear.listTeams(dto.apiKey);
  }

  @Post('linear/preview')
  @RequireCompanyRoles('Admin')
  linearPreview(@Body() dto: LinearPreviewDto) {
    return this.linear.previewTeam(dto.apiKey, dto.teamId, (dto.mapping ?? {}) as never);
  }

  @Post('linear/run')
  @RequireCompanyRoles('Admin')
  async linearRun(@CurrentUser() actor: AuthenticatedUser, @Body() dto: LinearRunDto) {
    return this.linear.runImport(dto.apiKey, dto.teamId, (dto.mapping ?? {}) as never, {
      actorUserId: actor.id,
      dryRun: Boolean((dto.options ?? {})['dryRun']),
    });
  }

  // -------------------------- Jira ------------------------------------------

  @Post('jira/projects')
  @RequireCompanyRoles('Admin')
  jiraProjects(@Body() dto: JiraCredsDto) {
    return this.jira.listProjects(dto);
  }

  @Post('jira/preview')
  @RequireCompanyRoles('Admin')
  jiraPreview(@Body() dto: JiraPreviewDto) {
    return this.jira.previewProject(
      { domain: dto.domain, email: dto.email, apiToken: dto.apiToken },
      dto.projectKey,
      (dto.mapping ?? {}) as never,
    );
  }

  @Post('jira/run')
  @RequireCompanyRoles('Admin')
  jiraRun(@CurrentUser() actor: AuthenticatedUser, @Body() dto: JiraRunDto) {
    return this.jira.runImport(
      { domain: dto.domain, email: dto.email, apiToken: dto.apiToken },
      dto.projectKey,
      (dto.mapping ?? {}) as never,
      {
        actorUserId: actor.id,
        dryRun: Boolean((dto.options ?? {})['dryRun']),
      },
    );
  }

  // -------------------------- Jira CSV (Pass D, no creds) -------------------

  @Post('jira-csv/run')
  @RequireCompanyRoles('Admin')
  @ApiOperation({ summary: 'Run a Jira CSV import (no API credentials)' })
  jiraCsvRun(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: {
      projectId: string;
      csvText: string;
      mapping?: JiraCsvMapping;
      options?: { dryRun?: boolean };
    },
  ) {
    if (!dto.projectId || !dto.csvText) {
      throw new BadRequestException('jira-csv/run requires projectId + csvText');
    }
    return this.jiraCsv.runImport(actor, dto.csvText, dto.mapping ?? {}, {
      actorUserId: actor.id,
      projectId: dto.projectId,
      dryRun: Boolean(dto.options?.dryRun),
    });
  }

  // -------------------------- GitHub Issues ---------------------------------

  @Post('github-issues/repos')
  @RequireCompanyRoles('Admin')
  ghRepos(@Body() dto: GhInstallationDto) {
    return this.ghIssues.listRepos(dto.installationId);
  }

  @Post('github-issues/preview')
  @RequireCompanyRoles('Admin')
  ghPreview(@Body() dto: GhPreviewDto) {
    return this.ghIssues.previewRepo(
      dto.installationId,
      dto.owner,
      dto.repo,
      (dto.mapping ?? {}) as never,
    );
  }

  @Post('github-issues/run')
  @RequireCompanyRoles('Admin')
  ghRun(@CurrentUser() actor: AuthenticatedUser, @Body() dto: GhRunDto) {
    return this.ghIssues.runImport(
      dto.installationId,
      dto.owner,
      dto.repo,
      (dto.mapping ?? {}) as never,
      {
        actorUserId: actor.id,
        projectId: dto.projectId,
        dryRun: Boolean((dto.options ?? {})['dryRun']),
      },
    );
  }

  // -------------------------- Unified mapper UI -----------------------------

  /**
   * Per-source field descriptors for the mapper UI. Returns the static
   * descriptor array each adapter exports as `fields`. The CSV variant
   * returns the canonical Nockta-target list; once a file is uploaded the
   * UI re-runs the parse endpoint and merges header-derived columns on top.
   */
  @Get('source-fields')
  @RequireCompanyRoles('Admin')
  @ApiOperation({ summary: 'Per-source field descriptors (drives the mapper UI)' })
  sourceFields(@Query('source') source?: string) {
    switch (source) {
      case 'csv':
        return { source, fields: csvFields };
      case 'linear':
        return { source, fields: linearFields };
      case 'jira-csv':
        return { source, fields: jiraCsvFields };
      case undefined:
      case '':
      case 'all':
        return {
          csv: csvFields,
          linear: linearFields,
          'jira-csv': jiraCsvFields,
        };
      default:
        throw new BadRequestException(`Unknown source "${source}"`);
    }
  }

  /**
   * Unified dry-run. Parses the first 50 rows, runs the same validation
   * pipeline as a real import, returns `{ preview, wouldInsert, wouldSkip }`
   * without persisting anything. See ImportsDryRunService for the
   * source-specific validators.
   */
  @Post('dry-run')
  @RequireCompanyRoles('Admin')
  @ApiOperation({ summary: 'Validate the first 50 rows without persisting' })
  dryRun(@CurrentUser() actor: AuthenticatedUser, @Body() dto: DryRunDto) {
    // Shape the inner payload per source so the union discriminant resolves.
    if (dto.source === 'csv') {
      if (!dto.projectId || !dto.csvText || !dto.mapping) {
        throw new BadRequestException('csv dry-run requires projectId, csvText, and mapping');
      }
      const payload: DryRunPayload = {
        source: 'csv',
        projectId: dto.projectId,
        csvText: dto.csvText,
        mapping: dto.mapping as Record<number, string>,
      };
      return this.dry.dryRun(actor, payload);
    }
    if (dto.source === 'jira-csv') {
      if (!dto.projectId || !dto.csvText) {
        throw new BadRequestException('jira-csv dry-run requires projectId + csvText');
      }
      const payload: DryRunPayload = {
        source: 'jira-csv',
        projectId: dto.projectId,
        csvText: dto.csvText,
        mapping: (dto.mapping ?? {}) as never,
      };
      return this.dry.dryRun(actor, payload);
    }
    if (dto.source === 'linear') {
      if (!Array.isArray(dto.sample)) {
        throw new BadRequestException('linear dry-run requires `sample` array (preview rows)');
      }
      const payload: DryRunPayload = {
        source: 'linear',
        sample: dto.sample as never,
        ...(dto.mapping ? { mapping: dto.mapping as never } : {}),
      };
      return this.dry.dryRun(actor, payload);
    }
    throw new BadRequestException(`Unsupported source: ${String(dto.source)}`);
  }

  // -------------------------- Runs ------------------------------------------

  @Get('runs')
  @RequireCompanyRoles('Admin')
  @ApiOperation({ summary: 'Last N import runs across all sources' })
  listRuns(@Query('limit') limit?: string) {
    const n = limit ? Math.min(Math.max(Number(limit), 1), 100) : 20;
    return this.runs.listRecent(n);
  }

  /**
   * Resume a previously-failed run from `resumableFromRow + 1`. Only the
   * original actor can resume; CSV is the supported source today. Linear /
   * Jira-CSV resume lives in their respective services and surfaces through
   * the same affordance once their resume payloads land.
   */
  @Post(':id/resume')
  @RequireCompanyRoles('Admin')
  @ApiOperation({ summary: 'Resume a partially-failed run from the last successful row' })
  resume(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') runId: string,
  ) {
    return this.csv.resume(actor, runId);
  }
}
