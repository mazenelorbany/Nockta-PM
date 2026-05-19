import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import type { DashboardScope, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';

type JsonObject = Record<string, unknown>;

export interface DashboardInput {
  name: string;
  description?: string | null;
  scope?: DashboardScope;
  widgets?: JsonObject[];
  baseFilters?: JsonObject;
}

@Injectable()
export class DashboardsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lists dashboards the actor can see — owned, workspace-public, or
   *  explicitly shared via DashboardAccess (user or team grant). */
  async listForUser(actor: AuthenticatedUser) {
    if (actor.kind !== 'internal') return [];
    const teamMemberships = await this.prisma.teamMember.findMany({
      where: { userId: actor.id }, select: { teamId: true },
    });
    const teamIds = teamMemberships.map((m) => m.teamId);
    return this.prisma.dashboard.findMany({
      where: {
        OR: [
          { ownerUserId: actor.id },
          { scope: 'workspace' },
          { access: { some: { userId: actor.id } } },
          teamIds.length ? { access: { some: { teamId: { in: teamIds } } } } : {},
        ].filter(Boolean) as Prisma.DashboardWhereInput[],
      },
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  async get(actor: AuthenticatedUser, id: string) {
    const dashboard = await this.prisma.dashboard.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        access: {
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
            team: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });
    if (!dashboard) throw new NotFoundException('Dashboard not found');
    await this.assertReadable(actor, dashboard);
    return dashboard;
  }

  async create(actor: AuthenticatedUser, input: DashboardInput) {
    if (actor.kind !== 'internal') throw new ForbiddenException('Internal only');
    if (!input.name?.trim()) throw new BadRequestException('Name is required');
    return this.prisma.dashboard.create({
      data: {
        name: input.name.trim(),
        description: input.description?.trim() || null,
        ownerUserId: actor.id,
        scope: input.scope ?? 'private',
        widgets: (input.widgets ?? []) as unknown as Prisma.InputJsonValue,
        baseFilters: (input.baseFilters ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async update(actor: AuthenticatedUser, id: string, patch: Partial<DashboardInput>) {
    const existing = await this.prisma.dashboard.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Dashboard not found');
    this.assertOwner(actor, existing);
    return this.prisma.dashboard.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
        ...(patch.widgets !== undefined ? { widgets: patch.widgets as unknown as Prisma.InputJsonValue } : {}),
        ...(patch.baseFilters !== undefined ? { baseFilters: patch.baseFilters as unknown as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async remove(actor: AuthenticatedUser, id: string) {
    const existing = await this.prisma.dashboard.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Dashboard not found');
    this.assertOwner(actor, existing);
    await this.prisma.dashboard.delete({ where: { id } });
    return { ok: true };
  }

  // ---------- Sharing ----------

  async addAccess(actor: AuthenticatedUser, dashboardId: string, input: { userId?: string; teamId?: string }) {
    const existing = await this.prisma.dashboard.findUnique({ where: { id: dashboardId } });
    if (!existing) throw new NotFoundException('Dashboard not found');
    this.assertOwner(actor, existing);
    if (!input.userId && !input.teamId) throw new BadRequestException('userId or teamId required');
    if (input.userId && input.teamId) throw new BadRequestException('Pick one of userId or teamId');
    return this.prisma.dashboardAccess.upsert({
      where: input.userId
        ? { dashboardId_userId: { dashboardId, userId: input.userId } }
        : { dashboardId_teamId: { dashboardId, teamId: input.teamId! } },
      update: {},
      create: { dashboardId, ...input },
    });
  }

  async removeAccess(actor: AuthenticatedUser, accessId: string) {
    const row = await this.prisma.dashboardAccess.findUnique({
      where: { id: accessId },
      include: { dashboard: true },
    });
    if (!row) throw new NotFoundException('Access row not found');
    this.assertOwner(actor, row.dashboard);
    await this.prisma.dashboardAccess.delete({ where: { id: accessId } });
    return { ok: true };
  }

  // ---------- Auth helpers ----------

  private assertOwner(actor: AuthenticatedUser, dashboard: { ownerUserId: string }): void {
    if (actor.companyRole === 'Admin') return;
    if (dashboard.ownerUserId !== actor.id) {
      throw new ForbiddenException('Only the owner can modify this dashboard');
    }
  }

  private async assertReadable(
    actor: AuthenticatedUser,
    dashboard: { ownerUserId: string; scope: DashboardScope; id: string },
  ): Promise<void> {
    if (actor.kind !== 'internal') throw new ForbiddenException('Internal only');
    if (actor.companyRole === 'Admin') return;
    if (dashboard.ownerUserId === actor.id) return;
    if (dashboard.scope === 'workspace') return;
    if (dashboard.scope === 'shared') {
      const teamMemberships = await this.prisma.teamMember.findMany({
        where: { userId: actor.id }, select: { teamId: true },
      });
      const teamIds = teamMemberships.map((m) => m.teamId);
      const granted = await this.prisma.dashboardAccess.findFirst({
        where: {
          dashboardId: dashboard.id,
          OR: [
            { userId: actor.id },
            teamIds.length ? { teamId: { in: teamIds } } : { teamId: '__never__' },
          ],
        },
      });
      if (granted) return;
    }
    throw new ForbiddenException('No access to this dashboard');
  }
}
