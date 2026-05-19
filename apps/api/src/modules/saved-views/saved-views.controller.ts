import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { SearchService } from '../search/search.service';

import { SavedViewsService} from './saved-views.service';
import { type SavedViewInput } from './saved-views.service';

class CreateSavedViewDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsObject() query!: Record<string, unknown>;
}

class UpdateSavedViewDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsObject() query?: Record<string, unknown>;
}

@ApiTags('saved-views')
@ApiBearerAuth()
@Controller('saved-views')
export class SavedViewsController {
  constructor(
    private readonly svc: SavedViewsService,
    private readonly search: SearchService,
  ) {}

  @Get()
  list(@CurrentUser() actor: AuthenticatedUser) {
    return this.svc.listForUser(actor);
  }

  @Post()
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateSavedViewDto) {
    return this.svc.create(actor, dto as SavedViewInput);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSavedViewDto,
  ) {
    return this.svc.update(actor, id, dto as Partial<SavedViewInput>);
  }

  @Delete(':id')
  remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.remove(actor, id);
  }

  /**
   * Promote a SavedView back into a SavedSearch (the inverse of
   * /search/saved/:id/promote-to-view). The two surfaces share the
   * `savedSearch` table; this just copies the filter JSON and wires the
   * cross-link bookkeeping. Idempotent.
   */
  @Post(':id/promote-to-search')
  promoteToSearch(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.search.promoteToSearch(actor, id);
  }
}
