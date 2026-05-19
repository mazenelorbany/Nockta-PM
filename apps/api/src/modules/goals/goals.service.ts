import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { GoalStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  /** List goals visible to the actor. Internal users see everything; clients see none. */
  async list(actor: AuthenticatedUser, status?: GoalStatus) {
    if (actor.kind !== 'internal') return [];
    return this.prisma.goal.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
        _count: { select: { tasks: true } },
      },
    });
  }

  async get(actor: AuthenticatedUser, goalId: string) {
    if (actor.kind !== 'internal') throw new ForbiddenException();
    const goal = await this.prisma.goal.findUnique({
      where: { id: goalId },
      include: {
        owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
        tasks: {
          include: {
            task: {
              select: {
                id: true, keyNumber: true, title: true, status: true, priority: true,
                isBlocked: true, dueDate: true,
                project: { select: { id: true, key: true, name: true } },
                assignee: { select: { id: true, name: true, avatarUrl: true } },
              },
            },
          },
          orderBy: { addedAt: 'desc' },
        },
      },
    });
    if (!goal) throw new NotFoundException('Goal not found');
    return goal;
  }

  async create(
    actor: AuthenticatedUser,
    input: {
      name: string;
      description?: string;
      startDate?: Date;
      targetDate?: Date;
      ownerUserId?: string;
    },
  ) {
    if (actor.kind !== 'internal') throw new ForbiddenException();
    const goal = await this.prisma.goal.create({
      data: {
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ownerUserId: input.ownerUserId ?? actor.id,
        ...(input.startDate ? { startDate: input.startDate } : {}),
        ...(input.targetDate ? { targetDate: input.targetDate } : {}),
      },
    });
    this.events.emit('goal.created', { goalId: goal.id, actorUserId: actor.id });
    return goal;
  }

  async update(
    actor: AuthenticatedUser,
    goalId: string,
    patch: {
      name?: string;
      description?: string | null;
      status?: GoalStatus;
      progress?: number | null;
      startDate?: Date | null;
      targetDate?: Date | null;
      ownerUserId?: string;
    },
  ) {
    if (actor.kind !== 'internal') throw new ForbiddenException();
    const goal = await this.prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal) throw new NotFoundException('Goal not found');
    // Only owner or Admin can edit.
    if (goal.ownerUserId !== actor.id && actor.companyRole !== 'Admin') {
      throw new ForbiddenException('Only the owner or an admin can edit this goal');
    }
    if (patch.progress !== undefined && patch.progress !== null) {
      patch.progress = Math.max(0, Math.min(100, Math.floor(patch.progress)));
    }
    const data: Prisma.GoalUncheckedUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.progress !== undefined) data.progress = patch.progress;
    if (patch.startDate !== undefined) data.startDate = patch.startDate;
    if (patch.targetDate !== undefined) data.targetDate = patch.targetDate;
    if (patch.ownerUserId !== undefined) data.ownerUserId = patch.ownerUserId;
    const updated = await this.prisma.goal.update({ where: { id: goalId }, data });
    this.events.emit('goal.updated', { goalId, actorUserId: actor.id });
    return updated;
  }

  async remove(actor: AuthenticatedUser, goalId: string) {
    if (actor.kind !== 'internal') throw new ForbiddenException();
    const goal = await this.prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal) throw new NotFoundException('Goal not found');
    if (goal.ownerUserId !== actor.id && actor.companyRole !== 'Admin') {
      throw new ForbiddenException();
    }
    await this.prisma.goal.delete({ where: { id: goalId } });
    this.events.emit('goal.deleted', { goalId, actorUserId: actor.id });
    return { ok: true };
  }

  // ---- task linking ----
  async linkTask(actor: AuthenticatedUser, goalId: string, taskId: string) {
    if (actor.kind !== 'internal') throw new ForbiddenException();
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, visibility: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    const canSee = await this.permissions.canSeeTask(actor, task.projectId, task.visibility);
    if (!canSee) throw new ForbiddenException();
    await this.prisma.goalTask.upsert({
      where: { goalId_taskId: { goalId, taskId } },
      update: {},
      create: { goalId, taskId, addedById: actor.id },
    });
    this.events.emit('goal.task_linked', { goalId, taskId, actorUserId: actor.id });
    return { ok: true };
  }

  async unlinkTask(actor: AuthenticatedUser, goalId: string, taskId: string) {
    if (actor.kind !== 'internal') throw new ForbiddenException();
    await this.prisma.goalTask
      .delete({ where: { goalId_taskId: { goalId, taskId } } })
      .catch(() => { /* idempotent */ });
    return { ok: true };
  }

  // ---------- Key Results ----------

  /** List KRs under a goal, ordered by position. */
  async listKeyResults(actor: AuthenticatedUser, goalId: string) {
    if (actor.kind !== 'internal') throw new ForbiddenException();
    const goal = await this.prisma.goal.findUnique({ where: { id: goalId }, select: { id: true } });
    if (!goal) throw new NotFoundException('Goal not found');
    return this.prisma.keyResult.findMany({
      where: { goalId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createKeyResult(
    actor: AuthenticatedUser,
    goalId: string,
    input: {
      name: string;
      unit?: string | null;
      kind?: 'number' | 'percent' | 'boolean' | 'revenue';
      targetValue?: number;
      currentValue?: number;
    },
  ) {
    if (actor.kind !== 'internal') throw new ForbiddenException();
    const goal = await this.prisma.goal.findUnique({ where: { id: goalId } });
    if (!goal) throw new NotFoundException('Goal not found');
    if (goal.ownerUserId !== actor.id && actor.companyRole !== 'Admin') {
      throw new ForbiddenException('Only the owner or an admin can add key results');
    }
    // Default values per kind — boolean's target is always 1, percent caps
    // at 100. Caller can override but the defaults make the new-KR form
    // single-tap for the common case.
    const kind = input.kind ?? 'number';
    const defaultTarget = kind === 'boolean' ? 1 : kind === 'percent' ? 100 : 100;
    return this.prisma.$transaction(async (tx) => {
      const maxPos = await tx.keyResult.aggregate({
        where: { goalId }, _max: { position: true },
      });
      const created = await tx.keyResult.create({
        data: {
          goalId,
          name: input.name.trim(),
          unit: input.unit ?? (kind === 'percent' ? '%' : kind === 'revenue' ? '$' : null),
          kind,
          targetValue: input.targetValue ?? defaultTarget,
          currentValue: input.currentValue ?? 0,
          position: (maxPos._max.position ?? -1) + 1,
          weight: 0, // redistribute below
        },
      });
      await this.redistributeWeights(tx, goalId);
      // Re-read the row so the caller sees the redistributed weight rather
      // than the temporary 0.
      return tx.keyResult.findUniqueOrThrow({ where: { id: created.id } });
    });
  }

  async updateKeyResult(
    actor: AuthenticatedUser,
    keyResultId: string,
    patch: { name?: string; unit?: string | null; targetValue?: number; currentValue?: number; position?: number },
  ) {
    if (actor.kind !== 'internal') throw new ForbiddenException();
    const kr = await this.prisma.keyResult.findUnique({
      where: { id: keyResultId },
      include: { goal: { select: { ownerUserId: true } } },
    });
    if (!kr) throw new NotFoundException('Key result not found');
    if (kr.goal.ownerUserId !== actor.id && actor.companyRole !== 'Admin') {
      throw new ForbiddenException('Only the owner or an admin can edit key results');
    }
    return this.prisma.keyResult.update({
      where: { id: keyResultId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.unit !== undefined ? { unit: patch.unit } : {}),
        ...(patch.targetValue !== undefined ? { targetValue: patch.targetValue } : {}),
        ...(patch.currentValue !== undefined ? { currentValue: patch.currentValue } : {}),
        ...(patch.position !== undefined ? { position: patch.position } : {}),
      },
    });
  }

  async removeKeyResult(actor: AuthenticatedUser, keyResultId: string) {
    if (actor.kind !== 'internal') throw new ForbiddenException();
    const kr = await this.prisma.keyResult.findUnique({
      where: { id: keyResultId },
      include: { goal: { select: { ownerUserId: true } } },
    });
    if (!kr) throw new NotFoundException('Key result not found');
    if (kr.goal.ownerUserId !== actor.id && actor.companyRole !== 'Admin') {
      throw new ForbiddenException();
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.keyResult.delete({ where: { id: keyResultId } });
      await this.redistributeWeights(tx, kr.goalId);
    });
    return { ok: true };
  }

  /**
   * Redistribute KR weights so they sum to exactly 100 within a single
   * goal. Called after create / delete and on update when an explicit
   * weight was set. Algorithm:
   *
   *   1. Snapshot existing weights.
   *   2. Scale them so the sum is 100 (e.g. four KRs with [10,20,30,40]
   *      stays [10,20,30,40]; three KRs with [25,25,25] becomes
   *      [33,33,34] — last entry absorbs the rounding remainder).
   *   3. If the snapshot sums to 0 (fresh goal, no weights set yet),
   *      distribute evenly: 100/N with remainder on the last entry.
   *
   * The function uses the supplied tx so callers can chain it inside a
   * larger transaction (e.g. create-then-redistribute).
   */
  private async redistributeWeights(
    tx: Prisma.TransactionClient,
    goalId: string,
  ): Promise<void> {
    const krs = await tx.keyResult.findMany({
      where: { goalId },
      orderBy: { position: 'asc' },
      select: { id: true, weight: true },
    });
    if (krs.length === 0) return;

    const sum = krs.reduce((acc, kr) => acc + kr.weight, 0);
    let next: number[];
    if (sum === 0) {
      // Even split.
      const base = Math.floor(100 / krs.length);
      const remainder = 100 - base * krs.length;
      next = krs.map((_, i) => (i === krs.length - 1 ? base + remainder : base));
    } else {
      // Proportional scale. Track running floor-sum so the LAST entry
      // absorbs any rounding leftover and the total is exactly 100.
      let running = 0;
      next = krs.map((kr, i) => {
        if (i === krs.length - 1) return 100 - running;
        const scaled = Math.round((kr.weight / sum) * 100);
        running += scaled;
        return scaled;
      });
    }
    // Write only the rows whose weight actually changed.
    await Promise.all(
      krs.map((kr, i) =>
        kr.weight === next[i]
          ? Promise.resolve(null)
          : tx.keyResult.update({ where: { id: kr.id }, data: { weight: next[i] } }),
      ),
    );
  }

  /**
   * Compute progress (0-100) for a goal. Priority:
   *   1. Manual override (goal.progress) wins if set.
   *   2. Weighted average of KR progress if any KRs exist.
   *   3. Else: linked-task done ratio if any tasks linked.
   *   4. Else: 0.
   *
   * Used by the rollup endpoint and the parent-goal aggregator.
   */
  private krProgressPct(kr: { currentValue: number; targetValue: number }): number {
    if (kr.targetValue === 0) return 0;
    return Math.max(0, Math.min(100, Math.round((kr.currentValue / kr.targetValue) * 100)));
  }

  /**
   * Returns the goal's effective progress AND the source — so the UI can
   * label it ("manual override" / "from 4 key results" / etc.).
   */
  async computeProgress(goalId: string): Promise<{
    progress: number;
    source: 'manual' | 'children' | 'key_results' | 'tasks' | 'empty';
  }> {
    const goal = await this.prisma.goal.findUnique({
      where: { id: goalId },
      include: {
        keyResults: { select: { weight: true, currentValue: true, targetValue: true } },
        children: { select: { id: true } },
        tasks: { include: { task: { select: { status: true } } } },
      },
    });
    if (!goal) return { progress: 0, source: 'empty' };
    if (goal.progress !== null) return { progress: goal.progress, source: 'manual' };

    // Goal trees: parent's progress is the weighted average of children
    // (children's own progress is computed recursively; we cap recursion
    // depth at 10 hops as a sanity bound on pathological data). When a
    // goal has BOTH children and KRs, children win — parent goals shouldn't
    // be measured directly when sub-objectives carry the actual work.
    if (goal.children.length > 0) {
      const childProgresses = await Promise.all(
        goal.children.map((c) => this.computeProgressBounded(c.id, 1)),
      );
      const avg = Math.round(
        childProgresses.reduce((a, b) => a + b, 0) / childProgresses.length,
      );
      return { progress: avg, source: 'children' };
    }

    if (goal.keyResults.length > 0) {
      // Weighted average. After redistribute, weights always sum to 100.
      const total = goal.keyResults.reduce(
        (acc, kr) => acc + this.krProgressPct(kr) * kr.weight,
        0,
      );
      const sumW = goal.keyResults.reduce((acc, kr) => acc + kr.weight, 0);
      const pct = sumW > 0 ? Math.round(total / sumW) : 0;
      return { progress: pct, source: 'key_results' };
    }

    if (goal.tasks.length > 0) {
      const done = goal.tasks.filter((gt) =>
        ['Done', 'Approved'].includes(gt.task.status),
      ).length;
      return {
        progress: Math.round((done / goal.tasks.length) * 100),
        source: 'tasks',
      };
    }
    return { progress: 0, source: 'empty' };
  }

  /** Recursion-bounded version of computeProgress for the parent walk. */
  private async computeProgressBounded(goalId: string, depth: number): Promise<number> {
    if (depth > 10) return 0; // pathological cycle / runaway tree
    const goal = await this.prisma.goal.findUnique({
      where: { id: goalId },
      include: {
        keyResults: { select: { weight: true, currentValue: true, targetValue: true } },
        children: { select: { id: true } },
        tasks: { include: { task: { select: { status: true } } } },
      },
    });
    if (!goal) return 0;
    if (goal.progress !== null) return goal.progress;
    if (goal.children.length > 0) {
      const child = await Promise.all(
        goal.children.map((c) => this.computeProgressBounded(c.id, depth + 1)),
      );
      return Math.round(child.reduce((a, b) => a + b, 0) / child.length);
    }
    if (goal.keyResults.length > 0) {
      const total = goal.keyResults.reduce(
        (acc, kr) => acc + this.krProgressPct(kr) * kr.weight,
        0,
      );
      const sumW = goal.keyResults.reduce((acc, kr) => acc + kr.weight, 0);
      return sumW > 0 ? Math.round(total / sumW) : 0;
    }
    if (goal.tasks.length > 0) {
      const done = goal.tasks.filter((gt) =>
        ['Done', 'Approved'].includes(gt.task.status),
      ).length;
      return Math.round((done / goal.tasks.length) * 100);
    }
    return 0;
  }
}
