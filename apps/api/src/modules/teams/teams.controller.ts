import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import type { TeamsService } from './teams.service';

class CreateTeamDto {
  @IsString() @Matches(/^[a-z0-9-]+$/) @MinLength(2) @MaxLength(40)
  slug!: string;

  @IsString() @MinLength(1) @MaxLength(80)
  name!: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;
}

class UpdateTeamDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

@ApiTags('teams')
@ApiBearerAuth()
@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get() list() { return this.teams.list(); }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.teams.get(id);
  }

  @Post()
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateTeamDto) {
    return this.teams.create(actor, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTeamDto,
  ) {
    return this.teams.update(actor, id, dto);
  }

  @Delete(':id')
  delete(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.teams.delete(actor, id);
  }

  @Post(':id/members/:userId')
  addMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.teams.addMember(actor, id, userId);
  }

  @Delete(':id/members/:userId')
  removeMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.teams.removeMember(actor, id, userId);
  }
}
