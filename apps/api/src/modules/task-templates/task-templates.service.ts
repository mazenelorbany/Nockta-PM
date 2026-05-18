import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateKeyBetween } from 'fractional-indexing';
import type { Priority, TaskType } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

export interface TaskTemplateInput {
  name: string;
  description?: string | null;
  titleTemplate: string;
  bodyTemplate?: string | null;
  priority?: Priority;
  estimate?: number | null;
  defaultStatus?: string | null;
  labelIds?: string[];
  /** Free-form tags used by the cross-project gallery for grouping. */
  tags?: string[];
  /** Task type the template emits. Null = type-agnostic (defaults to Task). */
  taskType?: TaskType | null;
}

/**
 * Filter applied to the workspace-wide template gallery. `type` and `tag` are
 * AND-combined (a template must satisfy both to appear).
 */
export interface TemplateGalleryFilter {
  /** Restrict to templates whose `taskType` equals this. Untyped templates
   *  (taskType: null) match every type — they're shown unconditionally. */
  type?: TaskType;
  /** Case-insensitive tag match. Templates without the tag are filtered out. */
  tag?: string;
  /** Substring search across name + description (case-insensitive). */
  q?: string;
}

@Injectable()
export class TaskTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  async listForProject(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    return this.prisma.taskTemplate.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Workspace-wide template gallery. Returns templates from every project the
   * user can READ (Viewer or better — Admins see all). The drawer's "+ New
   * Task" gallery hits this endpoint so a user creating work in Project A can
   * pull a recurring incident-template authored against Project B without
   * cross-project navigation.
   *
   * The returned shape always carries the source project's key/name so the
   * UI can render a per-project chip on each card. Admins short-circuit the
   * grant scan since they implicitly see every project.
   */
  async listGallery(actor: AuthenticatedUser, filter: TemplateGalleryFilter = {}) {
    const accessibleProjectIds = await this.resolveAccessibleProjectIds(actor);
    if (accessibleProjectIds.length === 0) return [];

    const tag = filter.tag?.trim().toLowerCase();
    const q = filter.q?.trim().toLowerCase();
    const rows = await this.prisma.taskTemplate.findMany({
      where: {
        projectId: { in: accessibleProjectIds },
        // Type filter: untyped templates (null) match every requested type.
        ...(filter.type ? { OR: [{ taskType: filter.type }, { taskType: null }] } : {}),
        ...(tag ? { tags: { has: tag } } : {}),
      },
      include: {
        project: { select: { id: true, key: true, name: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
      take: 200,
    });
    if (!q) return rows;
    return rows.filter((t) => {
      const hay = `${t.name}\n${t.description ?? ''}\n${t.titleTemplate}`.toLowerCase();
      return hay.includes(q);
    });
  }

  /**
   * The set of distinct, in-use tags across the gallery for THIS actor. Used
   * by the gallery's filter pill so the dropdown is populated from real data
   * rather than an arbitrary fixed list.
   */
  async listGalleryTags(actor: AuthenticatedUser): Promise<string[]> {
    const accessibleProjectIds = await this.resolveAccessibleProjectIds(actor);
    if (accessibleProjectIds.length === 0) return [];
    const rows = await this.prisma.taskTemplate.findMany({
      where: { projectId: { in: accessibleProjectIds } },
      select: { tags: true },
    });
    const set = new Set<string>();
    for (const r of rows) {
      for (const t of r.tags) {
        const norm = t.trim().toLowerCase();
        if (norm.length > 0) set.add(norm);
      }
    }
    return Array.from(set).sort();
  }

  /**
   * Internal: project ids the actor can list templates from. Admins see every
   * non-archived project; everyone else gets direct + team + public grants.
   * Returned as a plain array of UUIDs so callers can pass it to a Prisma `in`
   * filter directly.
   */
  private async resolveAccessibleProjectIds(actor: AuthenticatedUser): Promise<string[]> {
    if (actor.kind === 'internal' && actor.companyRole === 'Admin') {
      const all = await this.prisma.project.findMany({
        where: { archivedAt: null },
        select: { id: true },
      });
      return all.map((p) => p.id);
    }
    const memberships = actor.kind === 'internal'
      ? await this.prisma.teamMember.findMany({
          where: { userId: actor.id },
          select: { teamId: true },
        })
      : [];
    const teamIds = memberships.map((m) => m.teamId);
    const projects = await this.prisma.project.findMany({
      where: {
        archivedAt: null,
        OR: [
          { accessGrants: { some: { subjectKind: 'user', userId: actor.id } } },
          ...(teamIds.length > 0
            ? [{ accessGrants: { some: { subjectKind: 'team' as const, teamId: { in: teamIds } } } }]
            : []),
          ...(actor.kind === 'internal'
            ? [{ visibility: 'public' as const }]
            : []),
        ],
      },
      select: { id: true },
    });
    return projects.map((p) => p.id);
  }

  async create(actor: AuthenticatedUser, projectId: string, input: TaskTemplateInput) {
    await this.permissions.assertAtLeast(actor, projectId, 'Contributor');
    if (!input.name?.trim()) throw new BadRequestException('Name is required');
    if (!input.titleTemplate?.trim()) throw new BadRequestException('Title template is required');
    const tags = this.normaliseTags(input.tags);
    try {
      return await this.prisma.taskTemplate.create({
        data: {
          projectId,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          titleTemplate: input.titleTemplate.trim(),
          bodyTemplate: input.bodyTemplate ?? null,
          priority: input.priority ?? 'Medium',
          estimate: input.estimate ?? null,
          defaultStatus: input.defaultStatus ?? null,
          labelIds: input.labelIds ?? [],
          tags,
          taskType: input.taskType ?? null,
          createdById: actor.id,
        },
      });
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
        throw new BadRequestException(`Template "${input.name}" already exists`);
      }
      throw err;
    }
  }

  async update(actor: AuthenticatedUser, id: string, input: Partial<TaskTemplateInput>) {
    const t = await this.prisma.taskTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    await this.permissions.assertAtLeast(actor, t.projectId, 'Contributor');
    return this.prisma.taskTemplate.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.titleTemplate !== undefined ? { titleTemplate: input.titleTemplate.trim() } : {}),
        ...(input.bodyTemplate !== undefined ? { bodyTemplate: input.bodyTemplate } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
        ...(input.defaultStatus !== undefined ? { defaultStatus: input.defaultStatus } : {}),
        ...(input.labelIds !== undefined ? { labelIds: input.labelIds } : {}),
        ...(input.tags !== undefined ? { tags: this.normaliseTags(input.tags) } : {}),
        ...(input.taskType !== undefined ? { taskType: input.taskType } : {}),
      },
    });
  }

  /**
   * Tags are stored lowercased, trimmed, deduped, and capped at 10 per template
   * (32 chars each) so the gallery's "has tag" filter and the distinct-tags
   * query are predictable. Empty strings are dropped silently.
   */
  private normaliseTags(input: string[] | undefined): string[] {
    if (!input || input.length === 0) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of input) {
      const norm = String(raw).trim().toLowerCase().slice(0, 32);
      if (norm.length === 0 || seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
      if (out.length >= 10) break;
    }
    return out;
  }

  async remove(actor: AuthenticatedUser, id: string) {
    const t = await this.prisma.taskTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    await this.permissions.assertAtLeast(actor, t.projectId, 'Manager');
    await this.prisma.taskTemplate.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Create a task from a template. Title/body can be overridden, otherwise the
   * template fields are used verbatim.
   *
   * When `targetProjectId` is supplied the task lands in THAT project instead
   * of the template's owner project — the gallery uses this so a user can
   * pull a recurring "incident-postmortem" template from Project A into a
   * fresh bug in Project B. The actor must hold Contributor on the
   * destination; the source project only needs Viewer (templates are readable
   * to anyone who can see the project).
   */
  async instantiate(
    actor: AuthenticatedUser,
    id: string,
    overrides: { title?: string; description?: string | null; assigneeUserId?: string | null; dueDate?: string | null; sprintId?: string | null; targetProjectId?: string } = {},
  ) {
    const t = await this.prisma.taskTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    // The source project only needs to be readable (the template might live
    // somewhere the actor can only browse). Write permission is enforced on
    // the DESTINATION below.
    await this.permissions.assertAtLeast(actor, t.projectId, 'Viewer');
    const destinationProjectId = overrides.targetProjectId ?? t.projectId;
    await this.permissions.assertAtLeast(actor, destinationProjectId, 'Contributor');

    // Cross-project labels can't be carried over safely — labels are
    // per-project. We silently drop them when the destination differs to
    // avoid a foreign-key failure on the create.
    const carryLabels = destinationProjectId === t.projectId;

    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: destinationProjectId },
      select: { id: true, key: true, workflowPreset: true },
    });

    const status = t.defaultStatus ?? this.firstStatusFor(project.workflowPreset);

    // Move to bottom of column.
    const last = await this.prisma.task.findFirst({
      where: { projectId: project.id, status },
      orderBy: { boardPosition: 'desc' },
      select: { boardPosition: true },
    });
    const boardPosition = generateKeyBetween(last?.boardPosition ?? null, null);

    const updated = await this.prisma.project.update({
      where: { id: project.id },
      data: { nextTaskNumber: { increment: 1 } },
      select: { nextTaskNumber: true },
    });
    const keyNumber = updated.nextTaskNumber - 1;

    const task = await this.prisma.task.create({
      data: {
        projectId: project.id,
        keyNumber,
        ...(t.taskType ? { type: t.taskType } : {}),
        title: overrides.title?.trim() || t.titleTemplate,
        description: overrides.description !== undefined ? overrides.description : t.bodyTemplate,
        status,
        priority: t.priority,
        estimate: t.estimate,
        sprintId: overrides.sprintId ?? null,
        assigneeUserId: overrides.assigneeUserId ?? null,
        dueDate: overrides.dueDate ? new Date(overrides.dueDate) : null,
        boardPosition,
        reporterUserId: actor.id,
        createdById: actor.id,
        watchers: { create: [{ userId: actor.id }] },
        labels: carryLabels && t.labelIds.length
          ? { create: t.labelIds.map((labelId) => ({ labelId, addedById: actor.id })) }
          : undefined,
      },
    });
    return { ...task, key: `${project.key}-${task.keyNumber}` };
  }

  private firstStatusFor(preset: 'engineering' | 'design' | 'generic'): string {
    if (preset === 'engineering') return 'Todo';
    if (preset === 'design') return 'Todo';
    return 'Todo';
  }
}
