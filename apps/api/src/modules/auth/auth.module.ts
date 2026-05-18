import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { Env } from '../../config/env';
import { RedisModule } from '../redis/redis.module';

import { AuditLogService } from './audit-log.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { MailService } from './mail.service';
import { SessionService } from './session.service';
import { SessionsService } from './sessions.service';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: Env.JWT_ACCESS_SECRET,
      signOptions: { expiresIn: Env.JWT_ACCESS_TTL_SECONDS },
    }),
    RedisModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    MailService,
    SessionService,
    SessionsService,
    AuditLogService,
    GoogleStrategy,
    JwtStrategy,
    // Register JwtAuthGuard globally — opt out per route with @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // RolesGuard is opt-in (not registered globally); apply per-route via @UseGuards.
    RolesGuard,
  ],
  exports: [
    AuthService,
    SessionService,
    RolesGuard,
    MailService,
    AuditLogService,
    SessionsService,
  ],
})
export class AuthModule {}
