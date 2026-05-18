import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// AuditLogService — thin wrapper around AuditLogEntry. Every login/MFA/session
// event flows through `record()`. Reads are scoped per-user (recent activity
// in Settings → Security).
//
// Failure-of-record must never block the auth path. The DB write happens
// asynchronously (caller awaits) but exceptions are caught + logged so a
// transient DB hiccup doesn't 500 a login.
// =============================================================================

export type AuditAction =
  | 'login.google'
  | 'login.password'
  | 'login.magic_link'
  | 'login.dev'
  | 'logout'
  | 'session.revoked'
  | 'session.revoked_others'
  | 'token.refresh_reuse';

export interface AuditLogContext {
  userId: string | null;
  action: AuditAction;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(ctx: AuditLogContext): Promise<void> {
    try {
      await this.prisma.auditLogEntry.create({
        data: {
          userId: ctx.userId ?? null,
          action: ctx.action,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
          metadata: (ctx.metadata as never) ?? null,
        },
      });
    } catch (err) {
      // Never propagate — audit-log write failure must not break auth.
      this.logger.warn(
        { err, action: ctx.action, userId: ctx.userId },
        'Failed to write audit log entry',
      );
    }
  }

  async listForUser(userId: string, limit = 50) {
    return this.prisma.auditLogEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }
}
