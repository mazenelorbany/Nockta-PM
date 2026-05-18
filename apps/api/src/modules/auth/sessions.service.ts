import { createHash } from 'node:crypto';

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';

import type { AuditLogService } from './audit-log.service';

// =============================================================================
// SessionsService — user-facing refresh-token (= "session") management.
// Listing + revocation. Distinct from SessionService which owns the Redis
// JTI revocation set. Together they give the user-facing "sign out of this
// device" flow + the global revocation primitive.
// =============================================================================

export interface SessionRow {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
  expiresAt: Date;
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /// List all live refresh tokens for a user. `currentRefreshToken` (the raw
  /// value, if known to the caller) is used to tag exactly one row as
  /// `current: true` so the UI can highlight the device the user is on.
  async list(userId: string, currentRefreshToken?: string | null): Promise<SessionRow[]> {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    const currentHash = currentRefreshToken ? sha256(currentRefreshToken) : null;
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      // `lastSeenAt` isn't tracked separately — `createdAt` of the latest
      // rotated child IS the lastSeenAt for that chain. Cheap approximation
      // until we wire a real updatedAt on RefreshToken.
      lastSeenAt: r.createdAt,
      ip: r.ip,
      userAgent: r.userAgent,
      current: currentHash !== null && r.tokenHash === currentHash,
      expiresAt: r.expiresAt,
    }));
  }

  /// Revoke a single refresh token (= a single device). The owner check is
  /// inline — without it, any signed-in user could revoke any session.
  async revoke(
    userId: string,
    sessionId: string,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({ where: { id: sessionId } });
    if (!row) throw new NotFoundException('Session not found');
    if (row.userId !== userId) throw new ForbiddenException();
    if (row.revokedAt) return; // idempotent
    await this.prisma.refreshToken.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      userId,
      action: 'session.revoked',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { sessionId },
    });
  }

  /// Revoke every refresh token EXCEPT the one currently in the caller's
  /// possession. Useful for "sign out everywhere else" without nuking the
  /// device the user is reading the settings page on.
  async revokeOthers(
    userId: string,
    currentRefreshToken: string | null,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<{ count: number }> {
    const currentHash = currentRefreshToken ? sha256(currentRefreshToken) : null;
    const res = await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(currentHash ? { NOT: { tokenHash: currentHash } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      userId,
      action: 'session.revoked_others',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { count: res.count },
    });
    return { count: res.count };
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
