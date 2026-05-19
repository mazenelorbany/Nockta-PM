import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import { NotificationDigestService } from './digest.service';

class UpdateDigestPreferencesDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['email', 'chat']) channel?: 'email' | 'chat';
}

/**
 * REST surface for the "Smart digest" section of the Notifications settings
 * tab. Two endpoints:
 *   - GET   /notifications/digest          — current prefs + preview payload
 *   - PATCH /notifications/digest          — toggle + channel picker
 *
 * Kept on a separate controller from PreferencesController so the route layer
 * isn't tangled with the existing event-matrix endpoints. The PATCH payload
 * is a partial — sending only `enabled` leaves the channel untouched, and
 * vice versa.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications/digest')
export class DigestPreferencesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly digest: NotificationDigestService,
  ) {}

  @Get()
  async get(@CurrentUser() actor: AuthenticatedUser): Promise<{
    enabled: boolean;
    channel: 'email' | 'chat';
    preview: Awaited<ReturnType<NotificationDigestService['previewLatest']>>;
  }> {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: actor.id },
      select: { digestEnabled: true, digestChannel: true },
    });
    const preview = await this.digest.previewLatest(actor.id);
    return {
      enabled: u.digestEnabled,
      channel: (u.digestChannel === 'chat' ? 'chat' : 'email'),
      preview,
    };
  }

  @Patch()
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: UpdateDigestPreferencesDto,
  ): Promise<{ enabled: boolean; channel: 'email' | 'chat' }> {
    const data: { digestEnabled?: boolean; digestChannel?: string } = {};
    if (dto.enabled !== undefined) data.digestEnabled = dto.enabled;
    if (dto.channel !== undefined) data.digestChannel = dto.channel;
    const updated = await this.prisma.user.update({
      where: { id: actor.id },
      data,
      select: { digestEnabled: true, digestChannel: true },
    });
    return {
      enabled: updated.digestEnabled,
      channel: (updated.digestChannel === 'chat' ? 'chat' : 'email'),
    };
  }
}
