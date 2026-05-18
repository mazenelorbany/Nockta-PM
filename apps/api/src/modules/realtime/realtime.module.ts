import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthModule } from '../auth/auth.module';
import { Env } from '../../config/env';

import { RealtimeBroadcasterService } from './realtime-broadcaster.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [
    JwtModule.register({
      secret: Env.JWT_ACCESS_SECRET,
      signOptions: { expiresIn: Env.JWT_ACCESS_TTL_SECONDS },
    }),
    AuthModule,
  ],
  providers: [RealtimeGateway, RealtimeBroadcasterService],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
