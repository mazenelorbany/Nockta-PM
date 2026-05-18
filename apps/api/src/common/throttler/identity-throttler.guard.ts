import type { ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * ThrottlerGuard that namespaces the `user` bucket by authenticated user id
 * and the `global` / `auth` buckets by IP. JWT-authenticated requests are
 * limited per principal, anonymous requests fall back to IP. Matches the
 * spec §23 requirement of per-user + per-IP differentiation.
 */
@Injectable()
export class IdentityAwareThrottlerGuard extends ThrottlerGuard {
  protected override generateKey(context: ExecutionContext, suffix: string, name: string): string {
    if (name === 'user') {
      const req = this.getRequestResponse(context).req as { user?: { id?: string }; ip?: string };
      const userId = req.user?.id;
      if (userId) {
        return `throttle:user:${name}:${userId}:${suffix}`;
      }
      // Anonymous: fall back to IP so the bucket still applies pressure on
      // floods of unauthenticated requests.
    }
    return super.generateKey(context, suffix, name);
  }
}
