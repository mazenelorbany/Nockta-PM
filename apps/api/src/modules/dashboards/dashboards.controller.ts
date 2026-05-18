import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DashboardScope } from '@prisma/client';
import {
  IsArray, IsEnum, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength,
} from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import type { DashboardsService} from './dashboards.service';
import { type DashboardInput } from './dashboards.service';

class CreateDashboardDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsEnum(DashboardScope) scope?: DashboardScope;
  @IsOptional() @IsArray() widgets?: Record<string, unknown>[];
  @IsOptional() @IsObject() baseFilters?: Record<string, unknown>;
}

class UpdateDashboardDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsEnum(DashboardScope) scope?: DashboardScope;
  @IsOptional() @IsArray() widgets?: Record<string, unknown>[];
  @IsOptional() @IsObject() baseFilters?: Record<string, unknown>;
}

class AddAccessDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() teamId?: string;
}

@ApiTags('dashboards')
@ApiBearerAuth()
@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly svc: DashboardsService) {}

  @Get()
  list(@CurrentUser() actor: AuthenticatedUser) {
    return this.svc.listForUser(actor);
  }

  @Get(':id')
  get(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.get(actor, id);
  }

  @Post()
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateDashboardDto) {
    return this.svc.create(actor, dto as DashboardInput);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDashboardDto,
  ) {
    return this.svc.update(actor, id, dto as Partial<DashboardInput>);
  }

  @Delete(':id')
  remove(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.remove(actor, id);
  }

  @Post(':id/access')
  addAccess(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddAccessDto,
  ) {
    return this.svc.addAccess(actor, id, dto);
  }

  @Delete('access/:accessId')
  removeAccess(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('accessId', new ParseUUIDPipe()) accessId: string,
  ) {
    return this.svc.removeAccess(actor, accessId);
  }
}
