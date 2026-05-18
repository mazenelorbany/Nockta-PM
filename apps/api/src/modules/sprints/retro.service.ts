import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// SprintRetroService — Pass I (Sprints 8 → 9).
//
// Three responsibilities:
//
//   1. CRUD on SprintRetro (one per sprint). The retro carries the classic
//      three columns + a free-form action-item list. We don't enforce a fixed
//      schema on action items beyond a top-level shape check — teams shape
//      them differently and we'd rather rev the UI than the DB.
//
//   2. CRUD on SprintGoalEvaluation (one per sprint). A boolean "did we hit
//      the sprint goal" + an optional note. The actual hit-rate computation
//      lives in AnalyticsService (this service just persists the row).
//
//   3. listActionItems(projectId) — walks every retro in a project, flattens
//      their actionItems JSON, and returns an "open" / "done" filtered list
//      for the project's action-items panel.
//
// All write paths require Manager+ on the parent project. Reads require
// Viewer+. Listing is bound by the project filter so we don't need a
// permission check per row.
// =============================================================================

const MAX_TEXT_LEN = 5000;
const MAX_ACTION_ITEMS = 50;

export type ActionItemStatus = 'open' | 'done';

export interface ActionItem {
  /** Stable id for the row inside the JSON column — UUID generated server-side
   *  on first save so the UI can edit individual items by id. */
  id: string;
  description: string;
  ownerUserId?: string | null;
  status: ActionItemStatus;
  dueDate?: string | null; // ISO 8601 date
}

export interface RetroInput {
  whatWentWell?: string | null;
  whatCouldImprove?: string | null;
  actionItems?: ActionItem[];
}

/**
 * Validate + coerce raw input from the controller into the persisted shape.
 * Strips unknown keys and enforces caps so a 50KB description can't be
 * persisted into the JSON column.
 */
function normaliseActionItems(items: ActionItem[] | undefined): ActionItem[] {
  if (!items) return [];
  if (items.length > MAX_ACTION_ITEMS) {
    throw new BadRequestException(`Too many action items (max ${MAX_ACTION_ITEMS})`);
  }
  return items.map((raw, idx) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new BadRequestException(`Action item #${idx + 1} is not an object`);
    }
    const desc = String(raw.description ?? '').trim();
    if (desc.length === 0) {
      throw new BadRequestException(`Action item #${idx + 1} is missing a description`);
    }
    if (desc.length > 500) {
      throw new BadRequestException(`Action item #${idx + 1} description is over 500 chars`);
    }
    const status: ActionItemStatus = raw.status === 'done' ? 'done' : 'open';
    return {
      id: raw.id && /^[0-9a-f-]{8,}$/i.test(raw.id) ? raw.id : randomUUID(),
      description: desc,
      ownerUserId: raw.ownerUserId ?? null,
      status,
      dueDate: raw.dueDate ?? null,
    };
  });
}

function normaliseText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_TEXT_LEN) {
    throw new BadRequestException(`Retro field exceeds ${MAX_TEXT_LEN} characters`);
  }
  return trimmed;
}

@Injectable()
export class SprintRetroService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Upsert a retro for a sprint. The schema has a unique constraint on
   * sprintId so we use Prisma's upsert helper — running this twice in a row
   * with different inputs is a deliberate update, not a 409. The author is
   * preserved from the first save; we set it only on create so a second
   * editor doesn't accidentally claim authorship.
   */
  async createRetro(
    actor: AuthenticatedUser,
    sprintId: string,
    input: RetroInput,
  ) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      select: { id: true, projectId: true, state: true },
    });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Manager');

    const data = {
      whatWentWell: normaliseText(input.whatWentWell),
      whatCouldImprove: normaliseText(input.whatCouldImprove),
      actionItems: normaliseActionItems(input.actionItems) as unknown as Prisma.InputJsonValue,
    };

    const retro = await this.prisma.sprintRetro.upsert({
      where: { sprintId },
      create: {
        sprintId,
        authorUserId: actor.id,
        ...data,
      },
      update: data,
    });
    this.events.emit('sprint.retro_saved', {
      retroId: retro.id,
      sprintId,
      projectId: sprint.projectId,
      actorUserId: actor.id,
    });
    return retro;
  }

  /**
   * Read the retro for a sprint. Returns null if none has been written yet —
   * the UI can render an empty form against null rather than treating the
   * 404 as an error.
   */
  async getRetro(actor: AuthenticatedUser, sprintId: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      select: { projectId: true },
    });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Viewer');
    return this.prisma.sprintRetro.findUnique({
      where: { sprintId },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  /**
   * List every action item across all retros in a project, optionally
   * filtered by status. We DO NOT pull retro rows individually; one findMany
   * with a sprint filter is enough. The result is a flat list with the
   * source sprint stapled on so the UI can link back.
   *
   * Hydration: ownerUserId is resolved to a `{ id, name, avatarUrl }` so
   * the panel doesn't have to do an N+1.
   */
  async listActionItems(
    actor: AuthenticatedUser,
    projectId: string,
    opts: { status?: ActionItemStatus } = {},
  ) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    const retros = await this.prisma.sprintRetro.findMany({
      where: { sprint: { projectId } },
      select: {
        id: true,
        sprintId: true,
        actionItems: true,
        sprint: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const flat: Array<ActionItem & { sprintId: string; sprintName: string }> = [];
    for (const r of retros) {
      const items = Array.isArray(r.actionItems)
        ? (r.actionItems as unknown as ActionItem[])
        : [];
      for (const it of items) {
        if (opts.status && it.status !== opts.status) continue;
        flat.push({
          ...it,
          sprintId: r.sprintId,
          sprintName: r.sprint.name,
        });
      }
    }

    const ownerIds = Array.from(
      new Set(flat.map((it) => it.ownerUserId).filter((v): v is string => Boolean(v))),
    );
    const owners = ownerIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, name: true, avatarUrl: true },
        })
      : [];
    const ownerById = new Map(owners.map((o) => [o.id, o]));
    return flat.map((it) => ({
      ...it,
      owner: it.ownerUserId ? ownerById.get(it.ownerUserId) ?? null : null,
    }));
  }

  // ---- SprintGoalEvaluation ------------------------------------------------

  async evaluateGoal(
    actor: AuthenticatedUser,
    sprintId: string,
    input: { goalAchieved: boolean; note?: string | null },
  ) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      select: { id: true, projectId: true },
    });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Manager');

    const note = normaliseText(input.note);
    const row = await this.prisma.sprintGoalEvaluation.upsert({
      where: { sprintId },
      create: {
        sprintId,
        goalAchieved: input.goalAchieved,
        note,
        evaluatedByUserId: actor.id,
      },
      update: {
        goalAchieved: input.goalAchieved,
        note,
        evaluatedByUserId: actor.id,
        evaluatedAt: new Date(),
      },
    });
    this.events.emit('sprint.goal_evaluated', {
      sprintId,
      projectId: sprint.projectId,
      goalAchieved: row.goalAchieved,
      actorUserId: actor.id,
    });
    return row;
  }

  async getGoalEvaluation(actor: AuthenticatedUser, sprintId: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      select: { projectId: true },
    });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Viewer');
    return this.prisma.sprintGoalEvaluation.findUnique({
      where: { sprintId },
    });
  }
}
