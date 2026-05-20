import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationChannel } from '@prisma/client';
import {
  IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min,
} from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { PrismaService } from '../../prisma/prisma.service';

class UpsertPrefDto {
  @IsEnum(NotificationChannel) channel!: NotificationChannel;
  @IsString() eventType!: string;
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsBoolean() digestMode?: boolean;
  @IsOptional() @IsDateString() snoozeUntil?: string;
}

class SnoozeAllDto {
  // Accept either a minute-count (preferred — matches the bell / settings UI)
  // or a raw ISO timestamp (legacy callers). minutes=0 clears the snooze.
  @IsOptional() @IsInt() @Min(0) @Max(60 * 24 * 30) minutes?: number;
  @IsOptional() @IsDateString() until?: string;
}

// The sentinel row PreferencesService consults to short-circuit the per-event
// channel resolution. We tag it `__all__` so it doesn't collide with any real
// event type, and pick `in_app` as the channel only because the column is
// NOT NULL — the dispatcher reads `snoozeUntil` only.
const SNOOZE_ALL_EVENT = '__all__';
const SNOOZE_ALL_CHANNEL = 'in_app' as const;

@ApiTags('notification-preferences')
@ApiBearerAuth()
// Mounted at /notifications/preferences so the web/bell stay on one path
// prefix. The legacy /notification-preferences alias is also kept so older
// scripts (or the OpenAPI client cache) don't 404 silently.
@Controller(['notifications/preferences', 'notification-preferences'])
export class NotificationPreferencesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('projectId') projectId?: string,
  ) {
    return this.prisma.notificationPreference.findMany({
      where: { userId: actor.id, ...(projectId ? { projectId } : {}) },
    });
  }

  @Post()
  async upsert(@CurrentUser() actor: AuthenticatedUser, @Body() dto: UpsertPrefDto) {
    // Prisma compound unique with nullable column requires findFirst+update/create — the generated
    // compound-key shape doesn't accept null for the nullable field.
    //
    // The unique `(userId, channel, eventType, projectId)` index exists in
    // the schema, but Postgres treats NULL as distinct in unique indexes —
    // so two rows with `projectId IS NULL` both pass and the constraint is
    // effectively absent for the workspace-wide row. To get atomicity we
    // wrap the find-or-create in a Serializable transaction; two concurrent
    // upserts now produce one winner and one P2034 retry instead of two
    // duplicate rows that the dispatcher would then arbitrarily pick from.
    const data = {
      enabled: dto.enabled,
      digestMode: dto.digestMode ?? false,
      snoozeUntil: dto.snoozeUntil ? new Date(dto.snoozeUntil) : null,
    };
    const projectId = dto.projectId ?? null;
    return this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.notificationPreference.findFirst({
          where: {
            userId: actor.id,
            channel: dto.channel,
            eventType: dto.eventType,
            projectId,
          },
        });
        if (existing) {
          return tx.notificationPreference.update({ where: { id: existing.id }, data });
        }
        return tx.notificationPreference.create({
          data: {
            userId: actor.id,
            channel: dto.channel,
            eventType: dto.eventType,
            projectId,
            ...data,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  @Delete(':id')
  remove(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.prisma.notificationPreference.deleteMany({
      where: { id, userId: actor.id },
    });
  }

  /**
   * Workspace-wide snooze. Pass `{ minutes: N }` to mute everything for N
   * minutes; `{ minutes: 0 }` clears the snooze. Legacy callers may still pass
   * `{ until: ISO }` and we'll honor it. Implementation upserts a single
   * sentinel row so users with no existing prefs are also covered, then
   * also stamps every other row to the same timestamp (so a per-event preview
   * in the settings UI shows the snooze immediately).
   */
  @Patch('snooze-all')
  async snoozeAll(@CurrentUser() actor: AuthenticatedUser, @Body() body: SnoozeAllDto) {
    let snoozeUntil: Date | null;
    if (body.until) {
      snoozeUntil = new Date(body.until);
    } else if (typeof body.minutes === 'number') {
      snoozeUntil = body.minutes <= 0 ? null : new Date(Date.now() + body.minutes * 60_000);
    } else {
      snoozeUntil = null;
    }

    // Sentinel row keeps the snooze sticky even for users with zero per-event
    // prefs configured. The schema's unique on
    // (userId, channel, eventType, projectId) does NOT enforce uniqueness
    // for the sentinel because projectId=NULL, and Postgres treats NULL as
    // distinct in unique indexes. Without the Serializable transaction below,
    // two concurrent /snooze-all requests both find existing=null and both
    // create a sentinel — the dispatcher then sees two rows and picks one
    // arbitrarily, leaving the user with a "sometimes snoozed" experience.
    await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.notificationPreference.findFirst({
          where: {
            userId: actor.id,
            channel: SNOOZE_ALL_CHANNEL,
            eventType: SNOOZE_ALL_EVENT,
            projectId: null,
          },
        });
        if (existing) {
          await tx.notificationPreference.update({
            where: { id: existing.id },
            data: { snoozeUntil, enabled: true },
          });
        } else if (snoozeUntil) {
          await tx.notificationPreference.create({
            data: {
              userId: actor.id,
              channel: SNOOZE_ALL_CHANNEL,
              eventType: SNOOZE_ALL_EVENT,
              enabled: true,
              snoozeUntil,
            },
          });
        }
      },
      { isolationLevel: 'Serializable' },
    );
    // Mirror onto every existing pref so the settings UI shows the snooze
    // alongside per-event toggles.
    await this.prisma.notificationPreference.updateMany({
      where: { userId: actor.id, NOT: { eventType: SNOOZE_ALL_EVENT } },
      data: { snoozeUntil },
    });
    return { snoozeUntil };
  }
}
