import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { SchedulingModule } from './common/scheduling/scheduling.module';
import { IdentityAwareThrottlerGuard } from './common/throttler/identity-throttler.guard';
import { Env } from './config/env';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AiModule } from './modules/ai/ai.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { AuthModule } from './modules/auth/auth.module';
import { AutomationsModule } from './modules/automations/automations.module';
import { ChatModule } from './modules/chat/chat.module';
import { ClientModule } from './modules/client/client.module';
import { CommentsModule } from './modules/comments/comments.module';
import { CustomFieldsModule } from './modules/custom-fields/custom-fields.module';
import { DashboardsModule } from './modules/dashboards/dashboards.module';
import { DeploymentsModule } from './modules/deployments/deployments.module';
import { DocsModule } from './modules/docs/docs.module';
import { EventsModule } from './modules/events/events.module';
import { ExportsModule } from './modules/exports/exports.module';
import { GithubModule } from './modules/github/github.module';
import { GoalsModule } from './modules/goals/goals.module';
import { ImportModule } from './modules/import/import.module';
import { LabelsModule } from './modules/labels/labels.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OutboundWebhooksModule } from './modules/outbound-webhooks/outbound-webhooks.module';
import { PermissionsModule } from './modules/permissions/permissions.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RecurrenceModule } from './modules/recurrence/recurrence.module';
import { SavedViewsModule } from './modules/saved-views/saved-views.module';
import { SearchModule } from './modules/search/search.module';
import { RedisModule } from './modules/redis/redis.module';
import { SprintsModule } from './modules/sprints/sprints.module';
import { StorageModule } from './modules/storage/storage.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { TaskTemplatesModule } from './modules/task-templates/task-templates.module';
import { TeamsModule } from './modules/teams/teams.module';
import { UsersModule } from './modules/users/users.module';
import { WorklogModule } from './modules/worklog/worklog.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: Env.LOG_LEVEL,
        autoLogging: true,
        transport:
          Env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
            : undefined,
        formatters: { level: (label: string) => ({ level: label }) },
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password'],
      },
    }),
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 50,
      verboseMemoryLeak: true,
    }),
    ThrottlerModule.forRoot([
      // `global` is the default bucket: ~per-minute rolling cap per IP.
      { name: 'global', ttl: 60_000, limit: Env.RATE_LIMIT_GLOBAL_PER_MIN },
      // `user` enforces a per-authenticated-principal cap. The
      // IdentityAwareThrottlerGuard namespaces this bucket by JWT subject so a
      // shared NAT can't exhaust other users' quota and a single user can't
      // stay under the global ceiling by spreading load across IPs.
      { name: 'user', ttl: 60_000, limit: Env.RATE_LIMIT_PER_USER_PER_MIN },
      // `auth` is a much tighter bucket for endpoints that can be used to
      // spam email or brute-force credentials. Per-route @Throttle({ auth: ... })
      // opts into it explicitly — see AuthController.
      { name: 'auth', ttl: 60_000, limit: 10 },
    ]),
    PrismaModule,
    RedisModule,
    SchedulingModule,
    AuthModule,
    PermissionsModule,
    UsersModule,
    TeamsModule,
    ProjectsModule,
    TasksModule,
    TaskTemplatesModule,
    LabelsModule,
    ImportModule,
    MaintenanceModule,
    WorklogModule,
    GoalsModule,
    DocsModule,
    AutomationsModule,
    CustomFieldsModule,
    DashboardsModule,
    CommentsModule,
    SprintsModule,
    EventsModule,
    RealtimeModule,
    NotificationsModule,
    OutboundWebhooksModule,
    ExportsModule,
    StorageModule,
    AttachmentsModule,
    GithubModule,
    ChatModule,
    DeploymentsModule,
    RecurrenceModule,
    SavedViewsModule,
    SearchModule,
    AiModule,
    AnalyticsModule,
    ClientModule,
    HealthModule,
  ],
  providers: [
    // Enforce rate limits on every controller route by default. Routes that
    // need a stricter bucket use @Throttle({ auth: { ... } }) inline.
    { provide: APP_GUARD, useClass: IdentityAwareThrottlerGuard },
  ],
})
export class AppModule {}
