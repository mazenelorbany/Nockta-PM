import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { Env } from '../../config/env';
import { AuthModule } from '../auth/auth.module';
import { NotificationDigestService } from './digest.service';
import { DigestPreferencesController } from './digest.controller';
import { NotificationMutesController } from './mutes.controller';
import { NotificationMutesService } from './mutes.service';
import { NotificationDispatcherService, NOTIFICATION_QUEUE } from './notification-dispatcher.service';
import { NotificationProcessor } from './notification.processor';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationPreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';
import { RecipientResolverService } from './recipient-resolver.service';
import { NotificationSnoozeController } from './snooze.controller';
import { NotificationSnoozeService } from './snooze.service';

// =============================================================================
// Notifications module — wires the dispatcher pipeline + per-user surface.
//
// DECISION (Notifications 7→9): when a snooze window or mute applies, the
// dispatcher DROPS the in-flight notification rather than deferring it to
// a later deliverAt. A deferred-delivery path was considered and rejected
// because Notification has no `deliverAt` column and no worker exists to
// promote deferred rows to live ones — building both would more than
// double the surface area of this change for a UX that's near-identical
// (the user catches up via the digest scheduler that already runs).
// See notification-dispatcher.service.ts for the inline rationale.
// =============================================================================

const redisUrl = new URL(Env.REDIS_URL);

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379),
        ...(redisUrl.password ? { password: redisUrl.password } : {}),
      },
    }),
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
    AuthModule, // (magic-link MailService lives in AuthModule; not re-exported as a notification channel)
  ],
  controllers: [
    NotificationsController,
    NotificationPreferencesController,
    NotificationMutesController,
    NotificationSnoozeController,
    DigestPreferencesController,
  ],
  providers: [
    NotificationsService,
    NotificationDispatcherService,
    NotificationProcessor,
    PreferencesService,
    RecipientResolverService,
    NotificationMutesService,
    NotificationSnoozeService,
    NotificationDigestService,
  ],
  exports: [
    NotificationsService,
    PreferencesService,
    NotificationMutesService,
    NotificationSnoozeService,
    NotificationDigestService,
  ],
})
export class NotificationsModule {}
