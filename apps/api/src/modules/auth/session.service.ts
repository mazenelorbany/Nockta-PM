import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../redis/redis.module';
import { Env } from '../../config/env';

/**
 * Session-level state in Redis:
 *  - JWT JTI revocation (set when refresh token is revoked or reuse detected)
 *  - Online presence is layered on this in the realtime gateway later
 */
@Injectable()
export class SessionService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private revokeKey(jti: string): string {
    return `auth:jti:revoked:${jti}`;
  }

  async revokeJti(jti: string): Promise<void> {
    // TTL just slightly longer than access-token lifetime — after that, the JWT is expired anyway.
    await this.redis.set(this.revokeKey(jti), '1', 'EX', Env.JWT_ACCESS_TTL_SECONDS + 60);
  }

  async isJtiRevoked(jti: string): Promise<boolean> {
    const v = await this.redis.get(this.revokeKey(jti));
    return v === '1';
  }
}
