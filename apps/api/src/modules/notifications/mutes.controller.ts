import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import { NotificationMutesService} from './mutes.service';
import { type MuteableEntityType } from './mutes.service';

class MuteDto {
  @IsIn(['task', 'doc'])
  entityType!: MuteableEntityType;

  @IsUUID()
  entityId!: string;
}

@ApiTags('notification-mutes')
@ApiBearerAuth()
@Controller('notifications/mutes')
export class NotificationMutesController {
  constructor(private readonly mutes: NotificationMutesService) {}

  @Get()
  list(@CurrentUser() actor: AuthenticatedUser) {
    return this.mutes.list(actor.id);
  }

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async mute(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: MuteDto,
  ): Promise<void> {
    await this.mutes.mute(actor.id, dto.entityType, dto.entityId);
  }

  @Delete(':entityType/:entityId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unmute(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('entityType') entityType: string,
    @Param('entityId', new ParseUUIDPipe()) entityId: string,
  ): Promise<void> {
    if (entityType !== 'task' && entityType !== 'doc') return;
    await this.mutes.unmute(actor.id, entityType, entityId);
  }
}
