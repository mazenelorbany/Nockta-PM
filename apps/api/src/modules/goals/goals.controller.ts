import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GoalStatus } from '@prisma/client';
import {
  IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID,
  Max, MaxLength, Min, MinLength,
} from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import { GoalsService } from './goals.service';

class CreateGoalDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() targetDate?: string;
  @IsOptional() @IsUUID() ownerUserId?: string;
}
class UpdateGoalDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string | null;
  @IsOptional() @IsEnum(GoalStatus) status?: GoalStatus;
  @IsOptional() @IsInt() @Min(0) @Max(100) progress?: number | null;
  @IsOptional() @IsDateString() startDate?: string | null;
  @IsOptional() @IsDateString() targetDate?: string | null;
  @IsOptional() @IsUUID() ownerUserId?: string;
}

// KeyResult DTOs must be declared before the controller — JS classes are not
// hoisted, and Nest reflects on parameter types at module-load time. Defining
// them after the controller crashes the API at boot with a TDZ ReferenceError.
class CreateKeyResultDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(40) unit?: string | null;
  @IsOptional() @IsNumber() targetValue?: number;
  @IsOptional() @IsNumber() currentValue?: number;
}

class UpdateKeyResultDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(40) unit?: string | null;
  @IsOptional() @IsNumber() targetValue?: number;
  @IsOptional() @IsNumber() currentValue?: number;
  @IsOptional() @IsInt() position?: number;
}

@ApiTags('goals')
@ApiBearerAuth()
@Controller('goals')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  list(@CurrentUser() actor: AuthenticatedUser, @Query('status') status?: GoalStatus) {
    return this.goals.list(actor, status);
  }

  @Get(':id')
  get(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.goals.get(actor, id);
  }

  @Post()
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateGoalDto) {
    return this.goals.create(actor, {
      name: dto.name,
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.startDate ? { startDate: new Date(dto.startDate) } : {}),
      ...(dto.targetDate ? { targetDate: new Date(dto.targetDate) } : {}),
      ...(dto.ownerUserId ? { ownerUserId: dto.ownerUserId } : {}),
    });
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateGoalDto,
  ) {
    return this.goals.update(actor, id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.progress !== undefined ? { progress: dto.progress } : {}),
      ...(dto.startDate !== undefined
        ? { startDate: dto.startDate ? new Date(dto.startDate) : null }
        : {}),
      ...(dto.targetDate !== undefined
        ? { targetDate: dto.targetDate ? new Date(dto.targetDate) : null }
        : {}),
      ...(dto.ownerUserId !== undefined ? { ownerUserId: dto.ownerUserId } : {}),
    });
  }

  @Delete(':id')
  remove(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.goals.remove(actor, id);
  }

  @Post(':id/tasks/:taskId')
  link(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.goals.linkTask(actor, id, taskId);
  }

  @Delete(':id/tasks/:taskId')
  unlink(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.goals.unlinkTask(actor, id, taskId);
  }

  // ---- Key Results ----

  @Get(':id/key-results')
  listKeyResults(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.goals.listKeyResults(actor, id);
  }

  @Post(':id/key-results')
  createKeyResult(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateKeyResultDto,
  ) {
    return this.goals.createKeyResult(actor, id, dto);
  }

  @Patch('key-results/:krId')
  updateKeyResult(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('krId', new ParseUUIDPipe()) krId: string,
    @Body() dto: UpdateKeyResultDto,
  ) {
    return this.goals.updateKeyResult(actor, krId, dto);
  }

  @Delete('key-results/:krId')
  removeKeyResult(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('krId', new ParseUUIDPipe()) krId: string,
  ) {
    return this.goals.removeKeyResult(actor, krId);
  }
}
