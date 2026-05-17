import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate, normalizeLimit } from '../../common/pagination/cursor-pagination';
import type { AuthenticatedUser } from '../auth/types';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(actor: AuthenticatedUser, params: {
    cursor?: string;
    limit?: number;
    unreadOnly?: boolean;
    projectId?: string;
    /** Notification.type (e.g. "MentionedInComment"). Supports an `OR` set as comma-separated. */
    type?: string;
  }) {
    const limit = normalizeLimit(params.limit);
    const typeFilter = params.type
      ? params.type.includes(',')
        ? { in: params.type.split(',').map((s) => s.trim()).filter(Boolean) }
        : params.type
      : undefined;
    const rows = await this.prisma.notification.findMany({
      where: {
        recipientUserId: actor.id,
        ...(params.unreadOnly ? { readAt: null } : {}),
        ...(params.projectId ? { relatedProjectId: params.projectId } : {}),
        ...(typeFilter ? { type: typeFilter } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });
    return paginate(rows, limit, (n) => n.id);
  }

  async unreadCount(actor: AuthenticatedUser): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { recipientUserId: actor.id, readAt: null },
    });
    return { count };
  }

  async markRead(actor: AuthenticatedUser, ids: string[]): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id: { in: ids }, recipientUserId: actor.id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(actor: AuthenticatedUser): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { recipientUserId: actor.id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markUnread(actor: AuthenticatedUser, id: string): Promise<void> {
    // updateMany so a stale ID doesn't throw — also enforces ownership inline.
    await this.prisma.notification.updateMany({
      where: { id, recipientUserId: actor.id },
      data: { readAt: null },
    });
  }

  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n) throw new NotFoundException();
    if (n.recipientUserId !== actor.id) throw new ForbiddenException();
    await this.prisma.notification.delete({ where: { id } });
  }
}
