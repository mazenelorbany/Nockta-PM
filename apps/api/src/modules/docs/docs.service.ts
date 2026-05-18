import { Injectable, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { proseMirrorJsonToMarkdown, type ProseMirrorDoc } from './prosemirror-markdown';

@Injectable()
export class DocsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  /** List docs in a project (tree-flattened, ordered by parent then position). */
  async listForProject(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    return this.prisma.doc.findMany({
      where: { projectId, archivedAt: null },
      orderBy: [{ parentDocId: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, projectId: true, title: true, parentDocId: true, position: true,
        createdAt: true, updatedAt: true,
        author: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  async get(actor: AuthenticatedUser, docId: string) {
    const doc = await this.prisma.doc.findUnique({
      where: { id: docId },
      include: {
        author: { select: { id: true, name: true, email: true, avatarUrl: true } },
        project: { select: { id: true, key: true, name: true } },
      },
    });
    if (!doc) throw new NotFoundException('Doc not found');
    await this.permissions.assertAtLeast(actor, doc.projectId, 'Viewer');
    return doc;
  }

  async listRevisions(actor: AuthenticatedUser, docId: string) {
    const doc = await this.prisma.doc.findUnique({
      where: { id: docId },
      select: { projectId: true },
    });
    if (!doc) throw new NotFoundException();
    await this.permissions.assertAtLeast(actor, doc.projectId, 'Viewer');
    return this.prisma.docRevision.findMany({
      where: { docId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { author: { select: { id: true, name: true, avatarUrl: true } } },
    });
  }

  async create(
    actor: AuthenticatedUser,
    projectId: string,
    input: {
      title: string;
      body?: string;
      contentJson?: ProseMirrorDoc | null;
      parentDocId?: string;
    },
  ) {
    await this.permissions.assertAtLeast(actor, projectId, 'Contributor');
    // Body always wins as the markdown source-of-truth for FTS. When the
    // caller only sends contentJson (Tiptap-only client) we derive a minimal
    // markdown serialization here so the search_vector pipeline keeps working
    // without the editor needing to round-trip through the network.
    const resolvedBody =
      input.body ??
      (input.contentJson ? proseMirrorJsonToMarkdown(input.contentJson) : '');
    const data: Prisma.DocUncheckedCreateInput = {
      projectId,
      title: input.title,
      body: resolvedBody,
      authorUserId: actor.id,
    };
    if (input.contentJson !== undefined && input.contentJson !== null) {
      data.contentJson = input.contentJson as unknown as Prisma.InputJsonValue;
    }
    if (input.parentDocId) data.parentDocId = input.parentDocId;
    const doc = await this.prisma.doc.create({ data });
    // First revision = initial body so the timeline is complete from t=0.
    const revisionData: Prisma.DocRevisionUncheckedCreateInput = {
      docId: doc.id,
      title: doc.title,
      body: doc.body,
      authorUserId: actor.id,
    };
    if (input.contentJson !== undefined && input.contentJson !== null) {
      revisionData.contentJson = input.contentJson as unknown as Prisma.InputJsonValue;
    }
    await this.prisma.docRevision.create({ data: revisionData });
    this.events.emit('doc.created', { docId: doc.id, projectId, actorUserId: actor.id });
    return doc;
  }

  async update(
    actor: AuthenticatedUser,
    docId: string,
    patch: {
      title?: string;
      body?: string;
      contentJson?: ProseMirrorDoc | null;
      parentDocId?: string | null;
      position?: number;
    },
  ) {
    const doc = await this.prisma.doc.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException();
    await this.permissions.assertAtLeast(actor, doc.projectId, 'Contributor');

    // If contentJson is provided but body is not, derive body from JSON. This
    // is the common path for the Tiptap editor — it sends a single change
    // payload containing the new JSON tree and leaves markdown derivation to
    // the server so older clients (mobile, exports, FTS) keep reading body.
    const derivedBody =
      patch.body === undefined && patch.contentJson
        ? proseMirrorJsonToMarkdown(patch.contentJson)
        : patch.body;

    const data: Prisma.DocUncheckedUpdateInput = {};
    if (patch.title !== undefined) data.title = patch.title;
    if (derivedBody !== undefined) data.body = derivedBody;
    if (patch.position !== undefined) data.position = patch.position;
    if (patch.parentDocId !== undefined) data.parentDocId = patch.parentDocId;
    if (patch.contentJson !== undefined) {
      data.contentJson =
        patch.contentJson === null
          ? Prisma.JsonNull
          : (patch.contentJson as unknown as Prisma.InputJsonValue);
    }

    // Snapshot revision when the visible content changed (body, title, or
    // JSON tree). We compare derivedBody so a JSON-only change still creates
    // a revision even if the markdown happened to round-trip identically.
    const bodyChanged = derivedBody !== undefined && derivedBody !== doc.body;
    const titleChanged = patch.title !== undefined && patch.title !== doc.title;
    const jsonChanged = patch.contentJson !== undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.doc.update({ where: { id: docId }, data });
      if (bodyChanged || titleChanged || jsonChanged) {
        const revisionData: Prisma.DocRevisionUncheckedCreateInput = {
          docId,
          title: next.title,
          body: next.body,
          authorUserId: actor.id,
        };
        if (patch.contentJson !== undefined && patch.contentJson !== null) {
          revisionData.contentJson = patch.contentJson as unknown as Prisma.InputJsonValue;
        }
        await tx.docRevision.create({ data: revisionData });
      }
      return next;
    });

    this.events.emit('doc.updated', { docId, projectId: doc.projectId, actorUserId: actor.id });
    return updated;
  }

  async archive(actor: AuthenticatedUser, docId: string) {
    const doc = await this.prisma.doc.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException();
    if (doc.authorUserId !== actor.id) {
      await this.permissions.assertAtLeast(actor, doc.projectId, 'Manager');
    } else {
      await this.permissions.assertAtLeast(actor, doc.projectId, 'Contributor');
    }
    const updated = await this.prisma.doc.update({
      where: { id: docId },
      data: { archivedAt: new Date() },
    });
    this.events.emit('doc.archived', { docId, projectId: doc.projectId, actorUserId: actor.id });
    return updated;
  }

  /** Restore a previous revision into the current doc body. */
  async restoreRevision(actor: AuthenticatedUser, docId: string, revisionId: string) {
    const doc = await this.prisma.doc.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException();
    await this.permissions.assertAtLeast(actor, doc.projectId, 'Contributor');
    const rev = await this.prisma.docRevision.findUnique({ where: { id: revisionId } });
    if (!rev || rev.docId !== docId) throw new NotFoundException('Revision not found');
    return this.update(actor, docId, { title: rev.title, body: rev.body });
  }

  // ---------- Doc ↔ Task linking ----------

  async listDocsForTask(actor: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, visibility: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (!(await this.permissions.canSeeTask(actor, task.projectId, task.visibility))) {
      throw new NotFoundException('Task not found');
    }
    return this.prisma.docTask.findMany({
      where: { taskId },
      include: {
        doc: { select: { id: true, title: true, projectId: true } },
      },
      orderBy: { addedAt: 'desc' },
    });
  }

  async listTasksForDoc(actor: AuthenticatedUser, docId: string) {
    const doc = await this.prisma.doc.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException('Doc not found');
    await this.permissions.assertAtLeast(actor, doc.projectId, 'Viewer');
    return this.prisma.docTask.findMany({
      where: { docId },
      include: {
        task: {
          select: {
            id: true, keyNumber: true, title: true, status: true, priority: true, isBlocked: true,
            project: { select: { key: true } },
          },
        },
      },
      orderBy: { addedAt: 'desc' },
    });
  }

  async linkTaskToDoc(actor: AuthenticatedUser, docId: string, taskId: string) {
    const [doc, task] = await Promise.all([
      this.prisma.doc.findUnique({ where: { id: docId } }),
      this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } }),
    ]);
    if (!doc) throw new NotFoundException('Doc not found');
    if (!task) throw new NotFoundException('Task not found');
    // The doc + task can live in different projects (cross-project linking is
    // useful for shared specs). We require Contributor on whichever project
    // the doc lives in — that's the resource we're modifying.
    await this.permissions.assertAtLeast(actor, doc.projectId, 'Contributor');
    return this.prisma.docTask.upsert({
      where: { docId_taskId: { docId, taskId } },
      update: {},
      create: { docId, taskId },
    });
  }

  async unlinkTaskFromDoc(actor: AuthenticatedUser, docId: string, taskId: string) {
    const doc = await this.prisma.doc.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException('Doc not found');
    await this.permissions.assertAtLeast(actor, doc.projectId, 'Contributor');
    await this.prisma.docTask
      .delete({ where: { docId_taskId: { docId, taskId } } })
      .catch(() => undefined);
    return { ok: true };
  }

  // ---------- Doc comments ----------

  async listComments(actor: AuthenticatedUser, docId: string) {
    const doc = await this.prisma.doc.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException('Doc not found');
    await this.permissions.assertAtLeast(actor, doc.projectId, 'Viewer');
    return this.prisma.docComment.findMany({
      where: { docId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { id: true, name: true, avatarUrl: true } } },
    });
  }

  async addComment(
    actor: AuthenticatedUser,
    docId: string,
    body: string,
    parentCommentId?: string,
  ) {
    const doc = await this.prisma.doc.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException('Doc not found');
    await this.permissions.assertAtLeast(actor, doc.projectId, 'Contributor');

    // Flatten replies to one level — same pattern as task comments.
    let resolvedParentId: string | undefined;
    if (parentCommentId) {
      const parent = await this.prisma.docComment.findUnique({
        where: { id: parentCommentId },
        select: { id: true, docId: true, parentCommentId: true },
      });
      if (parent && parent.docId === docId) {
        resolvedParentId = parent.parentCommentId ?? parent.id;
      }
    }

    return this.prisma.docComment.create({
      data: {
        docId,
        authorUserId: actor.id,
        bodyMd: body,
        ...(resolvedParentId ? { parentCommentId: resolvedParentId } : {}),
      },
      include: { author: { select: { id: true, name: true, avatarUrl: true } } },
    });
  }

  async deleteComment(actor: AuthenticatedUser, commentId: string) {
    const comment = await this.prisma.docComment.findUnique({
      where: { id: commentId },
      include: { doc: { select: { projectId: true } } },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    // Author can delete their own; Manager+ can delete any.
    if (comment.authorUserId !== actor.id) {
      await this.permissions.assertAtLeast(actor, comment.doc.projectId, 'Manager');
    }
    await this.prisma.docComment.update({
      where: { id: commentId },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }
}
