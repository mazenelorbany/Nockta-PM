import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min,
} from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import type { RecurrenceService} from './recurrence.service';
import { type RecurrenceInput } from './recurrence.service';

const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;

class UpsertRecurrenceDto {
  @IsEnum(FREQUENCIES) frequency!: (typeof FREQUENCIES)[number];
  @IsOptional() @IsInt() @Min(1) @Max(365) interval?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(7) weekdays?: number[];
  @IsOptional() @IsInt() @Min(1) @Max(28) dayOfMonth?: number | null;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsDateString() endsAt?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@ApiTags('recurrence')
@ApiBearerAuth()
@Controller()
export class RecurrenceController {
  constructor(private readonly svc: RecurrenceService) {}

  @Get('tasks/:taskId/recurrence')
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.svc.getForTask(actor, taskId);
  }

  @Put('tasks/:taskId/recurrence')
  upsert(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body() dto: UpsertRecurrenceDto,
  ) {
    return this.svc.upsert(actor, taskId, dto as RecurrenceInput);
  }

  @Delete('tasks/:taskId/recurrence')
  remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.svc.remove(actor, taskId);
  }
}
