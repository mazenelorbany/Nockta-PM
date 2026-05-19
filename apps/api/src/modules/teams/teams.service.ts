import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';

function assertAdmin(actor: AuthenticatedUser): void {
  if (actor.companyRole !== 'Admin') {
    throw new ForbiddenException('Admin only');
  }
}

@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventEmitter2) {}

  list() {
    return this.prisma.team.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
  }

  async get(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: {
        members: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } },
      },
    });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }

  async create(actor: AuthenticatedUser, data: { slug: string; name: string; description?: string }) {
    assertAdmin(actor);
    const team = await this.prisma.team.create({
      data: {
        slug: data.slug,
        name: data.name,
        description: data.description ?? null,
        createdById: actor.id,
      },
    });
    this.events.emit('team.created', { teamId: team.id, actorUserId: actor.id });
    return team;
  }

  async update(actor: AuthenticatedUser, id: string, data: { name?: string; description?: string }) {
    assertAdmin(actor);
    const team = await this.prisma.team.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
      },
    });
    return team;
  }

  async delete(actor: AuthenticatedUser, id: string) {
    assertAdmin(actor);
    await this.prisma.team.delete({ where: { id } });
    this.events.emit('team.deleted', { teamId: id, actorUserId: actor.id });
  }

  async addMember(actor: AuthenticatedUser, teamId: string, userId: string) {
    assertAdmin(actor);
    await this.prisma.teamMember.upsert({
      where: { teamId_userId: { teamId, userId } },
      update: {},
      create: { teamId, userId },
    });
    this.events.emit('team.member_added', { teamId, userId, actorUserId: actor.id });
  }

  async removeMember(actor: AuthenticatedUser, teamId: string, userId: string) {
    assertAdmin(actor);
    await this.prisma.teamMember.delete({
      where: { teamId_userId: { teamId, userId } },
    });
    this.events.emit('team.member_removed', { teamId, userId, actorUserId: actor.id });
  }
}
