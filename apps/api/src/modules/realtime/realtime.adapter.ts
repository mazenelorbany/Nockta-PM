import { Logger } from '@nestjs/common';
import { type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';
import { Env } from '../../config/env';

/**
 * Socket.IO adapter backed by Redis pub/sub so we can horizontally scale the
 * websocket layer behind a load balancer. Wired in via main.ts.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | undefined;

  constructor(appOrServer: INestApplicationContext | unknown) {
    super(appOrServer as INestApplicationContext);
  }

  async connectToRedis(): Promise<void> {
    const pubClient = new Redis(Env.REDIS_URL, { maxRetriesPerRequest: null });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.ping(), subClient.ping()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('Socket.IO Redis adapter connected');
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: Env.CORS_ORIGINS,
        credentials: true,
      },
    }) as { adapter: (fn: ReturnType<typeof createAdapter>) => void };
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}
