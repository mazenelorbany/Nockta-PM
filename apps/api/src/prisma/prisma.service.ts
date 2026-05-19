import { Injectable, type OnModuleDestroy, type OnModuleInit, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { Env } from '../config/env';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Prisma 7 takes connection config through a driver adapter rather than
    // the legacy `datasources.db.url` option. PrismaPg wraps node-postgres
    // and accepts the same DATABASE_URL we used before.
    super({
      adapter: new PrismaPg({ connectionString: Env.DATABASE_URL }),
      log:
        Env.NODE_ENV === 'development'
          ? [{ level: 'warn', emit: 'event' }, { level: 'error', emit: 'event' }]
          : [{ level: 'error', emit: 'event' }],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
