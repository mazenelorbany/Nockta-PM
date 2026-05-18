import { Global, Module, type Provider } from '@nestjs/common';
import Redis from 'ioredis';

import { Env } from '../../config/env';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

const RedisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (): Redis =>
    new Redis(Env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    }),
};

@Global()
@Module({
  providers: [RedisProvider],
  exports: [RedisProvider],
})
export class RedisModule {}
