import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import type {
  NotificationSnoozeService} from './snooze.service';
import {
  ISO_DAYS,
  type IsoDay,
} from './snooze.service';

const ISO_DAYS_ARRAY: string[] = [...ISO_DAYS];

class CreateSnoozeRuleDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(ISO_DAYS_ARRAY, { each: true })
  daysOfWeek!: IsoDay[];

  @IsInt() @Min(0) @Max(23)
  startHour!: number;

  @IsInt() @Min(0) @Max(23)
  endHour!: number;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

class UpdateSnoozeRuleDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(ISO_DAYS_ARRAY, { each: true })
  daysOfWeek?: IsoDay[];

  @IsOptional() @IsInt() @Min(0) @Max(23)
  startHour?: number;

  @IsOptional() @IsInt() @Min(0) @Max(23)
  endHour?: number;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

@ApiTags('notification-snooze')
@ApiBearerAuth()
@Controller('notifications/snooze-rules')
export class NotificationSnoozeController {
  constructor(private readonly snooze: NotificationSnoozeService) {}

  @Get()
  list(@CurrentUser() actor: AuthenticatedUser) {
    return this.snooze.list(actor.id);
  }

  @Post()
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateSnoozeRuleDto,
  ) {
    return this.snooze.create(actor.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSnoozeRuleDto,
  ) {
    return this.snooze.update(actor.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.snooze.remove(actor.id, id);
  }
}
