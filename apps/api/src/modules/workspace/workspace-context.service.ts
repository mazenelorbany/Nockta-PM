import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// WorkspaceContextService
//
// Resolves the workspace boundary for an authenticated user. Every per-tenant
// query in the API now scopes by the workspaceId this service returns; the
// JWT carries the user id, this service maps user -> workspace, callers
// thread that workspaceId through to Prisma.
//
// Why a service (vs reading `user.workspaceId` ad-hoc):
//   - Caching: resolving on every request would re-query User per RPC. A
//     small in-memory map keyed by userId (TTL 60s) absorbs the hot path
//     without pulling in Redis.
//   - Single override point: tests can stub this service to flip the
//     workspace context without seeding two real users.
//   - Honest default: if the user row is genuinely missing (shouldn't
//     happen with a valid JWT, but defence-in-depth) we fall back to the
//     bootstrap 'default' workspace. That keeps the legacy single-tenant
//     path working — the boundary is enforced as soon as a non-default
//     row exists, but a fresh deploy doesn't 500 because the cache misses
//     for a brand-new user before any DB write completes.
//
// Cache TTL = 60s. Picked to balance:
//   - Long enough that the common request burst (≤ a few seconds of one
//     user firing dozens of RPCs) hits cache.
//   - Short enough that a workspace reassignment (admin-driven row move)
//     becomes visible within a minute without an explicit invalidation.
//   - Admin reassignment is rare; lazy-expiry is the right trade.
// =============================================================================

/** Bootstrap workspace id seeded by migration 0009. All legacy
 *  single-tenant rows attach to this id, and resolveForUser() falls back to
 *  it when the user row can't be located. */
export const DEFAULT_WORKSPACE_ID = 'default';

/** Cache TTL in milliseconds. Exported so tests can fast-forward by the
 *  documented duration rather than guessing. */
export const WORKSPACE_CACHE_TTL_MS = 60 * 1000;

interface CacheEntry {
  workspaceId: string;
  expiresAt: number;
}

@Injectable()
export class WorkspaceContextService {
  private readonly logger = new Logger(WorkspaceContextService.name);
  /** userId -> { workspaceId, expiresAt }. Tiny per-process map; not
   *  intended to scale across instances — workspace reassignment is rare
   *  and a 60s stale window across N pods is acceptable. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the workspace for a user. Returns the cached value when
   * still fresh, otherwise queries `User.workspaceId` and refreshes the
   * cache. Falls back to DEFAULT_WORKSPACE_ID when the user can't be
   * located (defensive — shouldn't fire on a valid JWT).
   */
  async resolveForUser(userId: string): Promise<string> {
    const now = Date.now();
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > now) {
      return cached.workspaceId;
    }
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { workspaceId: true },
    });
    const workspaceId = row?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    if (!row) {
      // A valid JWT but no matching User row is a sign of a deleted user
      // that still holds an unexpired token. We don't throw here — the
      // calling controller's auth guard will catch the deeper anomaly
      // separately; here we just return the bootstrap workspace so the
      // rest of the request pipeline doesn't crash.
      this.logger.warn(
        { userId },
        'workspace lookup: user row missing; falling back to default workspace',
      );
    }
    this.cache.set(userId, {
      workspaceId,
      expiresAt: now + WORKSPACE_CACHE_TTL_MS,
    });
    return workspaceId;
  }

  /** Bootstrap workspace id. Useful for system tasks (cron, processors)
   *  that aren't initiated by a user but still need a workspace scope —
   *  e.g. AI usage snapshots emitted by a background job. */
  getDefault(): string {
    return DEFAULT_WORKSPACE_ID;
  }

  /** Forget a single user's cached workspace. Called by the (future)
   *  admin reassignment endpoint so the next request sees the new value
   *  immediately rather than waiting out the TTL. */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /** Forget every cached workspace. Test hook + safety belt for processes
   *  that need to force a fresh read (e.g. a configuration reload). */
  invalidateAll(): void {
    this.cache.clear();
  }
}
