import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Prisma,
  type ProjectRole,
  type ProjectVisibility,
  type Visibility,
  type WorkflowPreset,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuthService } from '../auth/auth.service';
import { Env } from '../../config/env';
import type { AuthenticatedUser } from '../auth/types';
import { defaultTransitionsFor, WORKFLOW_STATUSES } from '../tasks/workflow';

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

interface InviteGuestInput {
  email: string;
  name?: string;
  role: 'Manager' | 'Contributor' | 'Viewer' | 'Client';
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
    private readonly auth: AuthService,
  ) {}

  async create(actor: AuthenticatedUser, input: CreateProjectInput) {
    assertAdmin(actor);
    if (!KEY_REGEX.test(input.key)) {
      throw new BadRequestException('Project key must be 2-10 uppercase letters');
    }
    try {
      // Project + default workflow transitions in one transaction so a new
      // project is never momentarily missing its edge set. The transitions
      // mirror migration 0028 + workflow.ts:defaultTransitionsFor — a
      // linear-with-reopen graph that explicitly excludes Todo → Done.
      const project = await this.prisma.$transaction(async (tx) => {
        const created = await tx.project.create({
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
        const edges = defaultTransitionsFor(input.workflowPreset);
        if (edges.length > 0) {
          await tx.projectWorkflowTransition.createMany({
            data: edges.map(([fromStatus, toStatus]) => ({
              projectId: created.id,
              fromStatus,
              toStatus,
            })),
          });
        }
        return created;
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

  // ---- Workflow transitions ----

  /**
   * Read the project's allowed (from → to) status edges. Viewer+ — the
   * board's status picker calls this to grey out disallowed targets in
   * the dropdown so users see the constraint before clicking.
   */
  async listWorkflowTransitions(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    const rows = await this.prisma.projectWorkflowTransition.findMany({
      where: { projectId },
      select: { id: true, fromStatus: true, toStatus: true },
      orderBy: [{ fromStatus: 'asc' }, { toStatus: 'asc' }],
    });
    return rows;
  }

  /**
   * Replace the project's transition set in a single transaction. Manager+.
   * Validates every edge against the project's preset so an admin can't
   * accidentally author edges for a status that doesn't exist in the
   * preset (which would silently no-op once enforcement reads the set).
   */
  async replaceWorkflowTransitions(
    actor: AuthenticatedUser,
    projectId: string,
    transitions: Array<{ fromStatus: string; toStatus: string }>,
  ) {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workflowPreset: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const validStatuses = new Set(WORKFLOW_STATUSES[project.workflowPreset] as readonly string[]);
    for (const t of transitions) {
      if (!validStatuses.has(t.fromStatus) || !validStatuses.has(t.toStatus)) {
        throw new BadRequestException(
          `Transition "${t.fromStatus}" → "${t.toStatus}" references a status outside the ${project.workflowPreset} preset.`,
        );
      }
      if (t.fromStatus === t.toStatus) {
        throw new BadRequestException(
          `Self-edges ("${t.fromStatus}" → "${t.fromStatus}") aren't meaningful; same-status transitions are handled as no-ops.`,
        );
      }
    }
    // Dedupe — the unique index would catch this with a P2002 but a clean
    // pre-check returns a friendlier error and keeps the transaction small.
    const dedup = new Map<string, { fromStatus: string; toStatus: string }>();
    for (const t of transitions) {
      dedup.set(`${t.fromStatus}→${t.toStatus}`, { fromStatus: t.fromStatus, toStatus: t.toStatus });
    }
    const next = Array.from(dedup.values());

    await this.prisma.$transaction(async (tx) => {
      await tx.projectWorkflowTransition.deleteMany({ where: { projectId } });
      if (next.length > 0) {
        await tx.projectWorkflowTransition.createMany({
          data: next.map((t) => ({ projectId, fromStatus: t.fromStatus, toStatus: t.toStatus })),
        });
      }
    });
    this.events.emit('project.workflow_updated', { projectId, actorUserId: actor.id, count: next.length });
    return next;
  }

  /** Reset the project's transitions to the preset's defaults. Manager+. */
  async resetWorkflowTransitions(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workflowPreset: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const edges = defaultTransitionsFor(project.workflowPreset);
    await this.prisma.$transaction(async (tx) => {
      await tx.projectWorkflowTransition.deleteMany({ where: { projectId } });
      if (edges.length > 0) {
        await tx.projectWorkflowTransition.createMany({
          data: edges.map(([fromStatus, toStatus]) => ({ projectId, fromStatus, toStatus })),
        });
      }
    });
    this.events.emit('project.workflow_updated', {
      projectId,
      actorUserId: actor.id,
      count: edges.length,
      reset: true,
    });
    return edges.map(([fromStatus, toStatus]) => ({ fromStatus, toStatus }));
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

  /**
   * One-call "invite an external collaborator to this project". Creates (or
   * fetches) the User row, grants project access, issues a long-TTL magic
   * link, and sends a personalised invitation email naming the project and
   * inviter. Idempotent on re-invite: re-using the same email re-sends the
   * link and either upserts the role or no-ops if the grant is identical.
   *
   * Authorisation: Manager (or above) on the project. The standalone
   * Admin-only `POST /users/invite-guest` still exists for company-wide
   * "make a guest with no specific project yet" cases.
   */
  async inviteGuest(actor: AuthenticatedUser, projectId: string, input: InviteGuestInput) {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');

    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Invalid email');
    }
    const domain = email.split('@')[1];
    if (domain === Env.GOOGLE_OAUTH_ALLOWED_DOMAIN) {
      throw new BadRequestException(
        `Invite-guest is for external collaborators. ${email} is on the company domain — ` +
          `they sign in via Google OAuth and don't need an invitation link.`,
      );
    }

    // Fetch project + actor in one round-trip; the email needs both names.
    const [project, actorRow] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, key: true },
      }),
      this.prisma.user.findUnique({
        where: { id: actor.id },
        select: { id: true, name: true, email: true },
      }),
    ]);
    if (!project) throw new NotFoundException('Project not found');
    if (!actorRow) throw new NotFoundException('Actor not found');

    const name = (input.name?.trim() || email.split('@')[0] || 'Guest').slice(0, 120);

    // Upsert the user row. An existing INTERNAL user can't be re-invited
    // as a guest — that would silently downgrade them on Google login.
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, kind: true },
    });
    if (existing && existing.kind === 'internal') {
      throw new BadRequestException(
        `${email} is already an internal user and can't be invited as a guest.`,
      );
    }
    // User upsert + ProjectAccess upsert in one transaction so two
    // concurrent inviteGuest calls for the same (email, project) don't:
    //   (a) double-create the access row (the @@unique([projectId,userId])
    //       on ProjectAccess would throw P2002 on the second create), or
    //   (b) leave a user row without a corresponding grant if the second
    //       write fails after the first commits.
    // The Prisma `upsert` keyed on `projectId_userId` lets us collapse the
    // previous findFirst+create/update branches into one atomic statement.
    // The SMTP send (auth.sendProjectInvite) stays OUTSIDE the transaction
    // — Resend latency would otherwise hold a row lock open for hundreds
    // of ms; an email failure shouldn't roll back the access grant.
    const { user, grantId } = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.upsert({
        where: { email },
        update: {},
        create: { email, name, kind: 'client', companyRole: null },
        select: { id: true },
      });
      const access = await tx.projectAccess.upsert({
        where: { projectId_userId: { projectId, userId: u.id } },
        update: { role: input.role, grantedById: actor.id },
        create: {
          projectId,
          subjectKind: 'user',
          userId: u.id,
          teamId: null,
          role: input.role,
          grantedById: actor.id,
        },
        select: { id: true },
      });
      return { user: u, grantId: access.id };
    });

    // Issue + email the invitation link. AuthService owns the magic-link
    // table and the SMTP send; we just pass the strings to render. The
    // `projectId` and `inviterUserId` get stamped on the MagicLink row so
    // the verify path can deep-link the recipient to this project, and the
    // admin "pending invitations" panel can list `Alice invited Bob to X`.
    await this.auth.sendProjectInvite({
      email,
      projectId: project.id,
      projectName: project.name,
      inviterUserId: actorRow.id,
      inviterName: actorRow.name || actorRow.email,
      role: input.role,
    });

    // Emit two events: the project-scoped one for activity timelines and
    // the user-scoped one so the notification dispatcher can fan it out
    // (e.g., notify other project managers that someone new was added).
    this.events.emit('project.guest_invited', {
      projectId,
      userId: user.id,
      grantId,
      role: input.role,
      actorUserId: actor.id,
    });

    return {
      userId: user.id,
      email,
      name,
      projectId,
      role: input.role,
      grantId,
      invitedAt: new Date().toISOString(),
    };
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

      // Seed default workflow transitions for the template's preset so a
      // freshly-cloned project enforces the same Todo → … → Done graph as
      // any other new project. Mirror of the seeding in create().
      const edges = defaultTransitionsFor(tpl.workflowPreset);
      if (edges.length > 0) {
        await tx.projectWorkflowTransition.createMany({
          data: edges.map(([fromStatus, toStatus]) => ({
            projectId: created.id,
            fromStatus,
            toStatus,
          })),
        });
      }

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
