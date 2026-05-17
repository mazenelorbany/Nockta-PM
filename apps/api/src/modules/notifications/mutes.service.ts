import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// NotificationMutesService — per-entity (task | doc) mute lookup + CRUD.
// The dispatcher consults `isMuted` BEFORE creating a notification; muted
// rows are dropped entirely (not deferred — the user signalled "I don't
// care about this thread anymore").
//
// Distinct from the legacy `TaskMute` table — that one is task-only and is
// kept for backward compat with TasksService. This service is the new
// general-purpose surface. Both are checked in the dispatcher.
// =============================================================================

export type MuteableEntityType = 'task' | 'doc';

@Injectable()
export class NotificationMutesService {
  constructor(private readonly prisma: PrismaService) {}

  async mute(
    userId: string,
    entityType: MuteableEntityType,
    entityId: string,
  ): Promise<void> {
    await this.prisma.notificationMute
      .create({
        data: { userId, entityType, entityId },
      })
      // Unique violation → already muted, treat as idempotent.
      .catch(() => undefined);
  }

  async unmute(
    userId: string,
    entityType: MuteableEntityType,
    entityId: string,
  ): Promise<void> {
    await this.prisma.notificationMute.deleteMany({
      where: { userId, entityType, entityId },
    });
  }

  async list(userId: string) {
    return this.prisma.notificationMute.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /// Cheap lookup used in the dispatcher hot path. Returns false when no
  /// entity is in scope (system events like deploy.succeeded with no task).
  async isMuted(
    userId: string,
    entityType: MuteableEntityType | null,
    entityId: string | null,
  ): Promise<boolean> {
    if (!entityType || !entityId) return false;
    const mute = await this.prisma.notificationMute.findUnique({
      where: {
        userId_entityType_entityId: { userId, entityType, entityId },
      },
    });
    return mute !== null;
  }
}
