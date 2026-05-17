import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';

export interface SavedViewInput {
  name: string;
  /** Free-form JSON describing the filters/view. Frontend owns the shape. */
  query: Record<string, unknown>;
}

@Injectable()
export class SavedViewsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(actor: AuthenticatedUser) {
    return this.prisma.savedSearch.findMany({
      where: { userId: actor.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(actor: AuthenticatedUser, input: SavedViewInput) {
    if (!input.name?.trim()) throw new BadRequestException('Name is required');
    return this.prisma.savedSearch.create({
      data: {
        userId: actor.id,
        name: input.name.trim(),
        query: input.query as Prisma.InputJsonValue,
      },
    });
  }

  async update(actor: AuthenticatedUser, id: string, input: Partial<SavedViewInput>) {
    const v = await this.prisma.savedSearch.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Saved view not found');
    if (v.userId !== actor.id) throw new ForbiddenException('Not your saved view');
    return this.prisma.savedSearch.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.query !== undefined ? { query: input.query as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async remove(actor: AuthenticatedUser, id: string) {
    const v = await this.prisma.savedSearch.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Saved view not found');
    if (v.userId !== actor.id) throw new ForbiddenException('Not your saved view');
    await this.prisma.savedSearch.delete({ where: { id } });
    return { ok: true };
  }
}
