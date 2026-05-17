import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Priority } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { type SearchInput, SearchService } from './search.service';

class SaveSearchDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsEnum(Priority) priority?: Priority;
  @IsOptional() @IsUUID() assigneeUserId?: string;
  @IsOptional() @IsUUID() sprintId?: string;
  @IsOptional() @IsBoolean() isBlocked?: boolean;
  @IsOptional() @IsBoolean() reportedByClient?: boolean;
  @IsOptional() @IsBoolean() hasAttachments?: boolean;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

function csv(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const arr = v.split(',').map((s) => s.trim()).filter(Boolean);
  return arr.length > 0 ? arr : undefined;
}

/**
 * Map the raw query string to a SearchInput. Multi-select params arrive as
 * comma-separated strings (e.g. `statuses=Todo,In%20Progress`) — we explode
 * them once here so the service stays agnostic of transport. Repeated query
 * params (`statuses=Todo&statuses=Done`) would also work but Nest's default
 * Query() shape returns a string for repeated keys; sticking to CSV keeps
 * client and server in agreement.
 */
function buildSearchInputFromQuery(query: Record<string, string>): SearchInput {
  const statuses = csv(query['statuses']);
  const priorities = csv(query['priorities']) as Priority[] | undefined;
  const projectIds = csv(query['projectIds']);
  const labelIds = csv(query['labelIds']);
  const assigneeUserIds = csv(query['assigneeUserIds']);
  const sprintIds = csv(query['sprintIds']);
  const types = csv(query['types']);
  const input: SearchInput = {
    ...(query['q'] ? { q: query['q'] } : {}),
    ...(query['projectId'] ? { projectId: query['projectId'] } : {}),
    ...(query['status'] ? { status: query['status'] } : {}),
    ...(query['priority'] ? { priority: query['priority'] as Priority } : {}),
    ...(query['assigneeUserId'] ? { assigneeUserId: query['assigneeUserId'] } : {}),
    ...(query['sprintId'] ? { sprintId: query['sprintId'] } : {}),
    ...(query['isBlocked'] !== undefined ? { isBlocked: query['isBlocked'] === 'true' } : {}),
    ...(query['reportedByClient'] !== undefined ? { reportedByClient: query['reportedByClient'] === 'true' } : {}),
    ...(query['hasAttachments'] !== undefined ? { hasAttachments: query['hasAttachments'] === 'true' } : {}),
    ...(query['from'] ? { from: new Date(query['from']) } : {}),
    ...(query['to'] ? { to: new Date(query['to']) } : {}),
    ...(query['cursor'] ? { cursor: query['cursor'] } : {}),
    ...(query['limit'] ? { limit: Number(query['limit']) } : {}),
    ...(statuses ? { statuses } : {}),
    ...(priorities ? { priorities } : {}),
    ...(projectIds ? { projectIds } : {}),
    ...(labelIds ? { labelIds } : {}),
    ...(assigneeUserIds ? { assigneeUserIds } : {}),
    ...(sprintIds ? { sprintIds } : {}),
    ...(types ? { types } : {}),
  };
  return input;
}

@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('tasks')
  searchTasks(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: Record<string, string>,
  ) {
    return this.search.searchTasks(actor, buildSearchInputFromQuery(query));
  }

  /**
   * Facet aggregates for the same query as searchTasks. Returns one bucket
   * list per dimension (status, priority, type, project, assignee, label,
   * sprint), each capped at 200 entries.
   */
  @Get('tasks/facets')
  facets(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: Record<string, string>,
  ) {
    return this.search.facets(actor, buildSearchInputFromQuery(query));
  }

  @Post('saved/:savedSearchId/promote-to-view')
  promoteToView(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('savedSearchId', new ParseUUIDPipe()) savedSearchId: string,
  ) {
    return this.search.promoteToView(actor, savedSearchId);
  }

  @Get('docs')
  searchDocs(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ) {
    return this.search.searchDocs(actor, q ?? '', limit ? Number(limit) : undefined);
  }

  @Get('saved')
  listSaved(@CurrentUser() actor: AuthenticatedUser) {
    return this.search.listSaved(actor);
  }

  @Post('saved')
  saveSearch(@CurrentUser() actor: AuthenticatedUser, @Body() dto: SaveSearchDto) {
    const { name, from, to, ...rest } = dto;
    const query: SearchInput = {
      ...rest,
      ...(from ? { from: new Date(from) } : {}),
      ...(to ? { to: new Date(to) } : {}),
    };
    return this.search.saveSearch(actor, name, query);
  }

  @Delete('saved/:id')
  deleteSaved(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.search.deleteSaved(actor, id);
  }
}
