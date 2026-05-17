import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// CommentTemplatesService — Pass I (Comments 8 → 9).
//
// Two scopes:
//
//   - Workspace-wide  (projectId = null) — any user can read; only Admins can
//                      mutate. These are the "official" templates that ship
//                      with the workspace.
//   - Project-scoped  (projectId set)    — Viewer+ can read; Manager+ can
//                      mutate. Useful for project-specific patterns that
//                      don't belong workspace-wide.
//
// The list endpoint returns BOTH scopes when a projectId is supplied, so the
// composer dropdown can show a single merged list. Each row carries a
// `scope: 'workspace' | 'project'` flag the UI can use to label.
//
// Names are NOT unique — two templates with the same name are allowed (often
// the case when a workspace template is "overridden" by a project-scoped
// copy that shadows it). The UI groups by scope so the user can tell them apart.
// =============================================================================

const MAX_NAME_LEN = 80;
const MAX_BODY_LEN = 4_000;

export interface CreateTemplateInput {
  name: string;
  body: string;
  /** When set, the template is project-scoped. Null = workspace-wide. */
  projectId?: string | null;
}

export interface UpdateTemplateInput {
  name?: string;
  body?: string;
}

@Injectable()
export class CommentTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * List templates the caller can see. If `projectId` is provided, the response
   * merges workspace-wide templates with that project's scoped templates.
   * Otherwise only workspace-wide rows come back.
   */
  async list(actor: AuthenticatedUser, projectId?: string | null) {
    if (projectId) {
      // Viewer+ on the project to see its scoped templates.
      const role = await this.permissions.effectiveRole(actor, projectId);
      if (role === null) throw new ForbiddenException('No project access');
    }
    const rows = await this.prisma.commentTemplate.findMany({
      where: {
        workspaceId: 'default',
        OR: [
          { projectId: null },
          ...(projectId ? [{ projectId }] : []),
        ],
      },
      orderBy: [{ projectId: 'asc' }, { name: 'asc' }],
      include: {
        createdBy: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    return rows.map((r) => ({
      ...r,
      scope: r.projectId === null ? ('workspace' as const) : ('project' as const),
    }));
  }

  async create(actor: AuthenticatedUser, input: CreateTemplateInput) {
    const name = String(input.name ?? '').trim();
    const body = String(input.body ?? '').trim();
    if (!name) throw new BadRequestException('Template name is required');
    if (name.length > MAX_NAME_LEN) {
      throw new BadRequestException(`Template name exceeds ${MAX_NAME_LEN} characters`);
    }
    if (!body) throw new BadRequestException('Template body is required');
    if (body.length > MAX_BODY_LEN) {
      throw new BadRequestException(`Template body exceeds ${MAX_BODY_LEN} characters`);
    }

    // Workspace-wide create: Admin only. Project-scoped: Manager+ on that
    // project. We deliberately don't allow a Manager to create workspace-wide
    // templates — that's an admin lever.
    if (!input.projectId) {
      if (actor.kind !== 'internal' || actor.companyRole !== 'Admin') {
        throw new ForbiddenException('Workspace templates require an Admin');
      }
    } else {
      await this.permissions.assertAtLeast(actor, input.projectId, 'Manager');
    }

    return this.prisma.commentTemplate.create({
      data: {
        workspaceId: 'default',
        projectId: input.projectId ?? null,
        name,
        body,
        createdByUserId: actor.id,
      },
    });
  }

  async update(actor: AuthenticatedUser, id: string, input: UpdateTemplateInput) {
    const existing = await this.prisma.commentTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Template not found');
    await this.assertCanMutate(actor, existing.projectId);

    const data: { name?: string; body?: string } = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw new BadRequestException('Name cannot be empty');
      if (name.length > MAX_NAME_LEN) {
        throw new BadRequestException(`Template name exceeds ${MAX_NAME_LEN} characters`);
      }
      data.name = name;
    }
    if (input.body !== undefined) {
      const body = String(input.body).trim();
      if (!body) throw new BadRequestException('Body cannot be empty');
      if (body.length > MAX_BODY_LEN) {
        throw new BadRequestException(`Template body exceeds ${MAX_BODY_LEN} characters`);
      }
      data.body = body;
    }
    if (Object.keys(data).length === 0) return existing;

    return this.prisma.commentTemplate.update({ where: { id }, data });
  }

  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    const existing = await this.prisma.commentTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Template not found');
    await this.assertCanMutate(actor, existing.projectId);
    await this.prisma.commentTemplate.delete({ where: { id } });
  }

  private async assertCanMutate(
    actor: AuthenticatedUser,
    projectId: string | null,
  ): Promise<void> {
    if (projectId === null) {
      if (actor.kind !== 'internal' || actor.companyRole !== 'Admin') {
        throw new ForbiddenException('Workspace templates require an Admin');
      }
      return;
    }
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
  }
}
