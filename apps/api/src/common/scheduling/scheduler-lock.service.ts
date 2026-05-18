import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { schedulerLockAcquisitions } from '../../health/metrics.controller';
import { REDIS_CLIENT } from '../../modules/redis/redis.module';

/**
 * Distributed scheduler lock — Redis SETNX-based leader election.
 *
 * Why this exists: every in-process scheduler in this codebase (digest,
 * maintenance, due-soon, recurrence, ai-cron) uses setInterval/@Cron and a
 * local `this.running` flag to prevent overlapping ticks. That's correct on a
 * single replica. With `numReplicas > 1`, every replica fires its own ticks
 * and you get duplicate work — partitions created N times, digest emails sent
 * N times, etc.
 *
 * `withLock` wraps a tick in a SET NX PX (set-if-not-exists with TTL) so only
 * one replica per tick actually runs the body. The lock token is the value;
 * we only release if it matches (Lua CAS) so a slow tick can't accidentally
 * release a different replica's freshly-acquired lock.
 *
 * Usage:
 *   await this.lock.withLock('digest:tick', 5 * 60_000, async () => {
 *     // ... actual work ...
 *   });
 *
 * The TTL should be longer than the expected work duration plus some headroom.
 * If the work runs over the TTL, another replica may pick up — that's a
 * deliberate failure mode (better duplicate than indefinitely stuck).
 */
@Injectable()
export class SchedulerLockService {
  private readonly logger = new Logger(SchedulerLockService.name);
  private static readonly KEY_PREFIX = 'lock:sched:';

  // Atomic compare-and-delete. Releases the lock only if the stored value
  // still matches the token we set. Prevents one replica from accidentally
  // releasing a lock another replica acquired after a TTL expiry.
  private static readonly RELEASE_LUA = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Acquire `key` for `ttlMs` and run `fn`. If another replica already holds
   * the lock, `fn` is skipped (returns `false`). The body's resolved value
   * (or `true` on void) is returned on success.
   */
  async withLock<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T | false> {
    const fullKey = `${SchedulerLockService.KEY_PREFIX}${key}`;
    // Unique token per call — distinguishes this replica's lock from a future
    // re-acquisition after TTL expiry by another replica.
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let acquired: 'OK' | null;
    try {
      acquired = await this.redis.set(fullKey, token, 'PX', ttlMs, 'NX');
    } catch (err) {
      schedulerLockAcquisitions.inc({ lock_key: key, outcome: 'error' });
      throw err;
    }
    if (acquired !== 'OK') {
      schedulerLockAcquisitions.inc({ lock_key: key, outcome: 'busy' });
      this.logger.debug(`Lock busy: ${key}`);
      return false;
    }
    schedulerLockAcquisitions.inc({ lock_key: key, outcome: 'acquired' });
    try {
      return await fn();
    } finally {
      try {
        await this.redis.eval(
          SchedulerLockService.RELEASE_LUA,
          1,
          fullKey,
          token,
        );
      } catch (err) {
        // Best-effort release; the TTL will reap it eventually.
        this.logger.warn(
          `Lock release failed for ${key}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
