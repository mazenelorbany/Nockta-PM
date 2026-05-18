import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Prisma,
  type ProjectRole,
  type ProjectVisibility,
  type Visibility,
  type WorkflowPreset,
} from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

interface CreateProjectInput {
  key: string;
  name: string;
  description?: string;
  visibility: ProjectVisibility;
  workflowPreset: WorkflowPreset;
  sprintsEnabled?: boolean;
}

interface GrantInput {
  subjectKind: 'user' | 'team';
  userId?: string;
  teamId?: string;
  role: ProjectRole;
}

const KEY_REGEX = /^[A-Z]{2,10}$/;

function assertAdmin(actor: AuthenticatedUser): void {
  if (actor.kind !== 'internal' || actor.companyRole !== 'Admin') {
    throw new ForbiddenException('Only Admins can perform this action');
  }
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  async create(actor: AuthenticatedUser, input: CreateProjectInput) {
    assertAdmin(actor);
    if (!KEY_REGEX.test(input.key)) {
      throw new BadRequestException('Project key must be 2-10 uppercase letters');
    }
    try {
      const project = await this.prisma.project.create({
        data: {
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          visibility: input.visibility,
          workflowPreset: input.workflowPreset,
          sprintsEnabled: input.sprintsEnabled ?? false,
          createdById: actor.id,
        },
      });
      this.events.emit('project.created', { projectId: project.id, actorUserId: actor.id });
      return project;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Project key ${input.key} is already in use`);
      }
      throw e;
    }
  }

  async listForUser(actor: AuthenticatedUser) {
    if (actor.kind === 'internal' && actor.companyRole === 'Admin') {
      return this.prisma.project.findMany({
        where: { archivedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (actor.kind === 'internal') {
      // Member: public projects + projects with a direct grant + projects via team
      const memberships = await this.prisma.teamMember.findMany({
        where: { userId: actor.id },
        select: { teamId: true },
      });
      const teamIds = memberships.map((m) => m.teamId);
      return this.prisma.project.findMany({
        where: {
          archivedAt: null,
          OR: [
            { visibility: 'public' },
            { accessGrants: { some: { userId: actor.id, subjectKind: 'user' } } },
            ...(teamIds.length > 0
              ? [{ accessGrants: { some: { subjectKind: 'team' as const, teamId: { in: teamIds } } } }]
              : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    // External (kind=client) user: only projects they have any explicit
    // grant on. Role can be Client (bug-only), Viewer (read-only), or
    // Contributor (full edit) depending on how they were invited; all three
    // should surface the project in the list. Filtering on role='Client'
    // here was the legacy assumption and broke contributor/viewer guests.
    return this.prisma.project.findMany({
      where: {
        archivedAt: null,
        accessGrants: { some: { userId: actor.id, subjectKind: 'user' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(actor: AuthenticatedUser, id: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');
    const role = await this.permissions.effectiveRole(actor, id);
    if (role === null) throw new ForbiddenException('No access to project');
    return { ...project, effectiveRole: role };
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    data: Partial<Pick<CreateProjectInput, 'name' | 'description' | 'visibility' | 'sprintsEnabled'>> & {
      githubAutoStatus?: boolean;
      chatSpaceId?: string | null;
      chatBroadcastEvents?: string[];
      maxAttachmentMb?: number;
      defaultTaskVisibility?: Visibility;
    },
  ) {
    await this.permissions.assertAtLeast(actor, id, 'Manager');
    const project = await this.prisma.project.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.visibility !== undefined ? { visibility: data.visibility } : {}),
        ...(data.sprintsEnabled !== undefined ? { sprintsEnabled: data.sprintsEnabled } : {}),
        ...(data.githubAutoStatus !== undefined ? { githubAutoStatus: data.githubAutoStatus } : {}),
        ...(data.chatSpaceId !== undefined ? { chatSpaceId: data.chatSpaceId } : {}),
        ...(data.chatBroadcastEvents !== undefined ? { chatBroadcastEvents: data.chatBroadcastEvents } : {}),
        ...(data.maxAttachmentMb !== undefined ? { maxAttachmentMb: data.maxAttachmentMb } : {}),
        ...(data.defaultTaskVisibility !== undefined
          ? { defaultTaskVisibility: data.defaultTaskVisibility }
          : {}),
      },
    });
    this.events.emit('project.updated', { projectId: id, actorUserId: actor.id });
    return project;
  }

  async archive(actor: AuthenticatedUser, id: string) {
    assertAdmin(actor);
    // Soft archive — does NOT destroy any data. A nightly purge sweep
    // (ProjectsPurgeProcessor) hard-deletes rows that have been sitting in
    // `archivedAt != null` for longer than the 7-day grace window. Until then
    // Admins can restore via `restore` below; the row is hidden from
    // listForUser() but still readable to anyone who has the project URL.
    const existing = await this.prisma.project.findUnique({
      where: { id },
      select: { id: true, archivedAt: true },
    });
    if (!existing) throw new NotFoundException('Project not found');
    // Idempotent — re-archiving a project already in the grace window leaves
    // the original `archivedAt` alone so the purge countdown doesn't reset
    // every time an Admin clicks Delete twice.
    if (existing.archivedAt) return;
    await this.prisma.project.update({ where: { id }, data: { archivedAt: new Date() } });
    this.events.emit('project.archived', { projectId: id, actorUserId: actor.id });
  }

  /**
   * Restore a previously-archived project. Only valid while the row is still
   * within the 7-day grace window — once the nightly purge hard-deletes it,
   * this throws `NotFoundException` (the row is genuinely gone, restore is
   * not a paid feature with a recovery tier behind it).
   */
  async restore(actor: AuthenticatedUser, id: string) {
    assertAdmin(actor);
    const existing = await this.prisma.project.findUnique({
      where: { id },
      select: { id: true, archivedAt: true },
    });
    if (!existing) {
      // Two reasons we can land here: a typo'd id (never existed) and a
      // genuinely-purged project (existed, was archived, purge cron deleted
      // it). Both surface the same way to the client; the controller maps
      // this to a 404 either way.
      throw new NotFoundException('Project not found (possibly purged after 7-day grace window)');
    }
    if (!existing.archivedAt) {
      // No-op: restoring an active project is a UI race (e.g. two Admins
      // clicking Restore + Archive simultaneously). Treat as success.
      return;
    }
    await this.prisma.project.update({ where: { id }, data: { archivedAt: null } });
    this.events.emit('project.restored', { projectId: id, actorUserId: actor.id });
  }

  /**
   * List projects currently in the 7-day grace window (`archivedAt != null`).
   * Surfaced by `/settings/archived-projects` so an Admin can pull the trigger
   * sooner (manual purge) or undo (restore) before the cron runs.
   */
  async listArchived(actor: AuthenticatedUser) {
    assertAdmin(actor);
    return this.prisma.project.findMany({
      where: { archivedAt: { not: null } },
      orderBy: { archivedAt: 'desc' },
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        archivedAt: true,
        createdAt: true,
        workflowPreset: true,
      },
    });
  }

  async listAccess(actor: AuthenticatedUser, projectId: string) {
    // Reading the member list is open to anyone on the project so the
    // overview hero can render avatars and the dashboard can show who else
    // is in the room. Manager stays gated for grant/revoke writes below.
    await this.permissions.assertAtLeast(actor, projectId, 'Client');
    return this.prisma.projectAccess.findMany({
      where: { projectId },
      include: {
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
        team: { select: { id: true, name: true, slug: true } },
      },
    });
  }

  async grantAccess(actor: AuthenticatedUser, projectId: string, input: GrantInput) {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    if (input.subjectKind === 'user' && !input.userId) {
      throw new BadRequestException('userId required for user grant');
    }
    if (input.subjectKind === 'team' && !input.teamId) {
      throw new BadRequestException('teamId required for team grant');
    }
    const grant = await this.prisma.projectAccess.create({
      data: {
        projectId,
        subjectKind: input.subjectKind,
        userId: input.subjectKind === 'user' ? input.userId! : null,
        teamId: input.subjectKind === 'team' ? input.teamId! : null,
        role: input.role,
        grantedById: actor.id,
      },
    });
    this.events.emit('project.access_granted', { projectId, grantId: grant.id, actorUserId: actor.id });
    return grant;
  }

  async revokeAccess(actor: AuthenticatedUser, projectId: string, grantId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    await this.prisma.projectAccess.delete({ where: { id: grantId } });
    this.events.emit('project.access_revoked', { projectId, grantId, actorUserId: actor.id });
  }

  // ---------- Project templates ----------

  async listTemplates(_actor: AuthenticatedUser) {
    return this.prisma.projectTemplate.findMany({
      orderBy: [{ name: 'asc' }],
      include: { createdBy: { select: { id: true, name: true } } },
    });
  }

  async createTemplate(
    actor: AuthenticatedUser,
    input: {
      name: string;
      description?: string | null;
      workflowPreset: WorkflowPreset;
      sprintsEnabled?: boolean;
      visibility?: ProjectVisibility;
      labels?: { name: string; color: string }[];
      sampleTasks?: { title: string; description?: string | null; type?: string; priority?: string; status?: string }[];
    },
  ) {
    assertAdmin(actor);
    return this.prisma.projectTemplate.create({
      data: {
        name: input.name.trim(),
        description: input.description ?? null,
        workflowPreset: input.workflowPreset,
        sprintsEnabled: input.sprintsEnabled ?? false,
        visibility: input.visibility ?? 'teams',
        labels: (input.labels ?? []) as unknown as Prisma.InputJsonValue,
        sampleTasks: (input.sampleTasks ?? []) as unknown as Prisma.InputJsonValue,
        createdById: actor.id,
      },
    });
  }

  async deleteTemplate(actor: AuthenticatedUser, id: string) {
    assertAdmin(actor);
    await this.prisma.projectTemplate.delete({ where: { id } });
    return { ok: true };
  }

  /** Create a new project by cloning a template's labels + sample tasks. */
  async createFromTemplate(
    actor: AuthenticatedUser,
    input: { templateId: string; key: string; name: string; description?: string },
  ) {
    assertAdmin(actor);
    if (!KEY_REGEX.test(input.key)) {
      throw new BadRequestException('Project key must be 2-10 uppercase letters');
    }
    const tpl = await this.prisma.projectTemplate.findUnique({ where: { id: input.templateId } });
    if (!tpl) throw new NotFoundException('Template not found');

    const project = await this.prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          visibility: tpl.visibility,
          workflowPreset: tpl.workflowPreset,
          sprintsEnabled: tpl.sprintsEnabled,
          createdById: actor.id,
        },
      });

      // Clone labels
      const labels = (tpl.labels as unknown as { name: string; color: string }[]) ?? [];
      if (labels.length > 0) {
        await tx.label.createMany({
          data: labels.map((l) => ({
            projectId: created.id,
            name: l.name,
            color: l.color,
          })),
          skipDuplicates: true,
        });
      }

      // Clone sample tasks. Previously this loop did 2N round-trips: one
      // `project.update` to bump nextTaskNumber, then one `task.create`. For
      // a 30-task template that's 60 sequential queries. Now we bump the
      // counter ONCE by sampleTasks.length and assign keyNumbers sequentially
      // in memory. Total: 2 queries instead of 2N.
      const sampleTasks = (tpl.sampleTasks as unknown as Array<{
        title: string; description?: string | null; type?: string; priority?: string; status?: string;
      }>) ?? [];
      if (sampleTasks.length > 0) {
        const bumped = await tx.project.update({
          where: { id: created.id },
          data: { nextTaskNumber: { increment: sampleTasks.length } },
          select: { nextTaskNumber: true },
        });
        // After the bump, nextTaskNumber points one PAST the last allocated
        // number, so the first task's key is `bumped.nextTaskNumber - sampleTasks.length`.
        const firstKey = bumped.nextTaskNumber - sampleTasks.length;
        // Build rows in JS then bulk-insert. `createMany` skips relation
        // writes (watchers), so we still need a follow-up insert for those —
        // but `task` rows themselves are one query.
        const rows = sampleTasks.map((s, i) => ({
          projectId: created.id,
          keyNumber: firstKey + i,
          title: s.title,
          description: s.description ?? null,
          status: s.status ?? 'Todo',
          priority: (s.priority as 'Low' | 'Medium' | 'High' | 'Critical' | undefined) ?? 'Medium',
          type: (s.type as 'Epic' | 'Story' | 'Task' | 'Bug' | 'Subtask' | undefined) ?? 'Task',
          // Fractional positions: a0, a1, a2 ... cheap monotonic ordering for the
          // initial seed; users can drag-reorder afterwards.
          boardPosition: `a${i.toString(36)}`,
          reporterUserId: actor.id,
          createdById: actor.id,
        }));
        await tx.task.createMany({ data: rows });
        // Attach the actor as watcher on every seeded task in one
        // createMany. This second roundtrip is still O(1) regardless of N
        // sampleTasks (was O(N) in the inline `watchers: { create: ... }`
        // path because each task.create issued its own watcher write).
        const created2 = await tx.task.findMany({
          where: { projectId: created.id },
          select: { id: true },
        });
        await tx.taskWatcher.createMany({
          data: created2.map((t) => ({ userId: actor.id, taskId: t.id })),
          skipDuplicates: true,
        });
      }

      return created;
    });

    this.events.emit('project.created', {
      projectId: project.id,
      actorUserId: actor.id,
      fromTemplate: input.templateId,
    });
    return project;
  }
}
