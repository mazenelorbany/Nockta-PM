import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

@Injectable()
export class LabelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  /** List labels in a project. Any project member can see. */
  async listForProject(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Client');
    return this.prisma.label.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
  }

  /** Create a new label. Requires Contributor or above. */
  async create(
    actor: AuthenticatedUser,
    projectId: string,
    input: { name: string; color?: string },
  ) {
    await this.permissions.assertAtLeast(actor, projectId, 'Contributor');
    const name = input.name.trim();
    if (!name) throw new BadRequestException('Name is required');
    const color = (input.color ?? 'A78BFA').replace(/^#/, '').toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(color)) {
      throw new BadRequestException('Color must be a 6-character hex (e.g. A78BFA)');
    }
    try {
      const label = await this.prisma.label.create({
        data: { projectId, name, color },
      });
      this.events.emit('label.created', { labelId: label.id, projectId, actorUserId: actor.id });
      return label;
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
        throw new BadRequestException(`Label "${name}" already exists`);
      }
      throw err;
    }
  }

  async update(actor: AuthenticatedUser, labelId: string, input: { name?: string; color?: string }) {
    const label = await this.prisma.label.findUnique({ where: { id: labelId } });
    if (!label) throw new NotFoundException('Label not found');
    await this.permissions.assertAtLeast(actor, label.projectId, 'Contributor');
    const data: { name?: string; color?: string } = {};
    if (input.name !== undefined) {
      const n = input.name.trim();
      if (!n) throw new BadRequestException('Name cannot be empty');
      data.name = n;
    }
    if (input.color !== undefined) {
      const c = input.color.replace(/^#/, '').toUpperCase();
      if (!/^[0-9A-F]{6}$/.test(c)) {
        throw new BadRequestException('Color must be a 6-character hex');
      }
      data.color = c;
    }
    return this.prisma.label.update({ where: { id: labelId }, data });
  }

  async remove(actor: AuthenticatedUser, labelId: string) {
    const label = await this.prisma.label.findUnique({ where: { id: labelId } });
    if (!label) throw new NotFoundException('Label not found');
    await this.permissions.assertAtLeast(actor, label.projectId, 'Manager');
    await this.prisma.label.delete({ where: { id: labelId } });
    this.events.emit('label.deleted', { labelId, projectId: label.projectId, actorUserId: actor.id });
    return { ok: true };
  }

  /** Attach a label to a task. */
  async attach(actor: AuthenticatedUser, taskId: string, labelId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    const label = await this.prisma.label.findUnique({ where: { id: labelId } });
    if (!label) throw new NotFoundException('Label not found');
    if (label.projectId !== task.projectId) {
      throw new BadRequestException('Label belongs to a different project');
    }
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');

    await this.prisma.taskLabel.upsert({
      where: { taskId_labelId: { taskId, labelId } },
      update: {},
      create: { taskId, labelId, addedById: actor.id },
    });
    this.events.emit('task.labeled', {
      taskId, labelId, projectId: task.projectId, actorUserId: actor.id,
    });
    return { ok: true };
  }

  async detach(actor: AuthenticatedUser, taskId: string, labelId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');
    await this.prisma.taskLabel.delete({
      where: { taskId_labelId: { taskId, labelId } },
    }).catch(() => { /* idempotent */ });
    this.events.emit('task.unlabeled', {
      taskId, labelId, projectId: task.projectId, actorUserId: actor.id,
    });
    return { ok: true };
  }

  /** List the labels attached to a task. */
  async listForTask(actor: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, visibility: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    const canSee = await this.permissions.canSeeTask(actor, task.projectId, task.visibility);
    if (!canSee) throw new ForbiddenException('No access');
    const rows = await this.prisma.taskLabel.findMany({
      where: { taskId },
      include: { label: true },
      orderBy: { addedAt: 'asc' },
    });
    return rows.map((r) => r.label);
  }
}
