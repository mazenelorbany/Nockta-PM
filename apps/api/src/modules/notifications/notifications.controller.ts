import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import type { NotificationsService } from './notifications.service';

class MarkReadDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID(undefined, { each: true })
  ids!: string[];
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('projectId') projectId?: string,
    @Query('type') type?: string,
  ) {
    return this.notifications.listForUser(actor, {
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      unreadOnly: unreadOnly === 'true',
      ...(projectId ? { projectId } : {}),
      ...(type ? { type } : {}),
    });
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() actor: AuthenticatedUser) {
    return this.notifications.unreadCount(actor);
  }

  // Bulk: mark a list of IDs as read. POST /notifications/read with { ids: [...] }
  @Post('read')
  markReadBulk(@CurrentUser() actor: AuthenticatedUser, @Body() dto: MarkReadDto) {
    return this.notifications.markRead(actor, dto.ids);
  }

  // Single: mark one notification as read. The bell component and inbox call
  // this on row-click so the badge updates immediately without re-fetching.
  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markOneRead(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.notifications.markRead(actor, [id]);
  }

  // Single: undo a mark-read (back to unread). Used by the inbox row menu.
  @Post(':id/unread')
  @HttpCode(HttpStatus.NO_CONTENT)
  markOneUnread(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.notifications.markUnread(actor, id);
  }

  // Mark every unread for the current user. Both legacy and bell-style paths
  // hit the same handler so existing clients don't need an update.
  @Post('read-all')
  markAllReadLegacy(@CurrentUser() actor: AuthenticatedUser) {
    return this.notifications.markAllRead(actor);
  }
  @Post('mark-all-read')
  markAllRead(@CurrentUser() actor: AuthenticatedUser) {
    return this.notifications.markAllRead(actor);
  }

  @Delete(':id')
  delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.notifications.delete(actor, id);
  }
}
