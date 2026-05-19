import { ForbiddenException, Injectable } from '@nestjs/common';
import type { EventVisibility, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { paginate, normalizeLimit } from '../../common/pagination/cursor-pagination';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

interface BrowseParams {
  cursor?: string;
  limit?: number;
}

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  // --------- Activity Timeline (user-facing) ---------

  async timelineForProject(actor: AuthenticatedUser, projectId: string, params: BrowseParams) {
    const role = await this.permissions.effectiveRole(actor, projectId);
    if (role === null) throw new ForbiddenException('No access to project');
    return this.queryTimeline(actor, role, { projectId }, params);
  }

  async timelineForEntity(actor: AuthenticatedUser, entityType: string, entityId: string, projectId: string | null, params: BrowseParams) {
    let role: 'Manager' | 'Contributor' | 'Viewer' | 'Client' | null = null;
    if (projectId) {
      role = await this.permissions.effectiveRole(actor, projectId);
      if (role === null) throw new ForbiddenException('No access');
    } else if (!(actor.kind === 'internal' && actor.companyRole === 'Admin')) {
      // Cross-project queries require admin
      throw new ForbiddenException('Project context required');
    }
    return this.queryTimeline(actor, role, { entityType, entityId }, params);
  }

  async myActivity(actor: AuthenticatedUser, params: BrowseParams) {
    return this.queryTimeline(actor, null, { actorUserId: actor.id }, params);
  }

  // --------- Audit Log (admin-only) ---------

  async auditLog(
    actor: AuthenticatedUser,
    filters: { type?: string; actorUserId?: string; from?: Date; to?: Date } & BrowseParams,
  ) {
    if (!(actor.kind === 'internal' && actor.companyRole === 'Admin')) {
      throw new ForbiddenException('Admin only');
    }
    const limit = normalizeLimit(filters.limit);
    const where: Prisma.EventWhereInput = {
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    };
    const events = await this.prisma.event.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id_createdAt: this.decodeEventCursor(filters.cursor) }, skip: 1 } : {}),
      include: { actor: { select: { id: true, name: true, email: true } } },
    });
    return paginate(events, limit, (e) => this.encodeEventCursor(e.id, e.createdAt));
  }

  // --------- Internal ---------

  private async queryTimeline(
    actor: AuthenticatedUser,
    role: 'Manager' | 'Contributor' | 'Viewer' | 'Client' | null,
    base: Prisma.EventWhereInput,
    params: BrowseParams,
  ) {
    const limit = normalizeLimit(params.limit);
    const visibilityFilter = this.visibilityFor(actor, role);
    const where: Prisma.EventWhereInput = {
      ...base,
      visibility: { in: visibilityFilter },
    };
    const events = await this.prisma.event.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(params.cursor ? { cursor: { id_createdAt: this.decodeEventCursor(params.cursor) }, skip: 1 } : {}),
      include: { actor: { select: { id: true, name: true, avatarUrl: true } } },
    });
    // Extra client safety: drop events whose payload marks them internal
    const filtered = role === 'Client' || actor.kind === 'client'
      ? events.filter((e) => !((e.payload as Record<string, unknown>)?.['isInternal'] === true))
      : events;
    return paginate(filtered, limit, (e) => this.encodeEventCursor(e.id, e.createdAt));
  }

  private visibilityFor(actor: AuthenticatedUser, role: 'Manager' | 'Contributor' | 'Viewer' | 'Client' | null): EventVisibility[] {
    if (actor.kind === 'internal' && actor.companyRole === 'Admin') {
      return ['public', 'internal', 'admin_only'];
    }
    if (role === 'Client' || actor.kind === 'client') {
      return ['public'];
    }
    return ['public', 'internal'];
  }

  private encodeEventCursor(id: string, createdAt: Date): string {
    return Buffer.from(`${id}|${createdAt.toISOString()}`, 'utf8').toString('base64url');
  }

  private decodeEventCursor(cursor: string): { id: string; createdAt: Date } {
    const [id, ts] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return { id: id!, createdAt: new Date(ts!) };
  }
}
