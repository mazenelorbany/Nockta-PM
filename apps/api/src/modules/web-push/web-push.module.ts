import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebPushController } from './web-push.controller';
import { WebPushService } from './web-push.service';
import { WebPushListener } from './web-push.listener';

// =============================================================================
// WebPushModule
//
// Exposes:
//   - WebPushService — inject anywhere fan-out is needed (notifications,
//     direct admin pings, etc.).
//   - REST endpoints for subscribe / unsubscribe / vapid-public-key.
//
// Hooks into the existing in-app notification fan-out via the
// `notification.created` EventEmitter2 event — the listener turns that into
// a parallel web-push.dispatch call so the in-app notification path itself
// stays untouched.
// =============================================================================

@Module({
  imports: [AuthModule],
  controllers: [WebPushController],
  providers: [WebPushService, WebPushListener],
  exports: [WebPushService],
})
export class WebPushModule {}
