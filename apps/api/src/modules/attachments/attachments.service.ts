import { randomUUID } from 'node:crypto';
import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { type AttachmentParentType, type Visibility } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';
import { PermissionsService } from '../permissions/permissions.service';
import { StorageService } from '../storage/storage.service';

export const ATTACHMENT_SCAN_QUEUE = 'attachment-scan';
export const ATTACHMENT_THUMB_QUEUE = 'attachment-thumb';

const MAX_FILE_BYTES_HARD = 500 * 1024 * 1024;

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.msi', '.dmg',
  '.app', '.jar', '.com', '.scr', '.vbs',
]);

function isBlockedFilename(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of BLOCKED_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  // Double-extension trick: `foo.pdf.exe`
  const segments = lower.split('.');
  if (segments.length >= 3) {
    const beforeLast = `.${segments[segments.length - 2]}`;
    if (BLOCKED_EXTENSIONS.has(beforeLast)) return true;
  }
  return false;
}

function slugifyFilename(name: string): string {
  const dotIdx = name.lastIndexOf('.');
  const base = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
  const ext = dotIdx >= 0 ? name.slice(dotIdx) : '';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || 'file'}${ext.toLowerCase().slice(0, 16)}`;
}

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
    @InjectQueue(ATTACHMENT_SCAN_QUEUE) private readonly scanQueue: Queue,
    @InjectQueue(ATTACHMENT_THUMB_QUEUE) private readonly thumbQueue: Queue,
  ) {}

  // --------- sign / confirm flow ---------

  async sign(actor: AuthenticatedUser, input: {
    parentType: AttachmentParentType;
    parentId: string;
    filename: string;
    mimeType: string;
    size: number;
  }): Promise<{ uploadId: string; storageKey: string; putUrl: string; expiresInSeconds: number }> {
    if (input.size <= 0 || input.size > MAX_FILE_BYTES_HARD) {
      throw new BadRequestException(`Size out of range (max ${MAX_FILE_BYTES_HARD} bytes)`);
    }
    if (isBlockedFilename(input.filename)) {
      throw new BadRequestException('File extension not allowed');
    }

    const { projectId } = await this.resolveParentContext(input.parentType, input.parentId);
    const role = await this.permissions.effectiveRole(actor, projectId);
    if (role === null) throw new ForbiddenException('No access');
    if (role === 'Viewer') throw new ForbiddenException('Viewers cannot upload');

    // Enforce the per-project cap. Admins set this in project settings (default
    // 100 MB; clamped at the hard 500 MB cap by the DTO + the project edit form).
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { maxAttachmentMb: true },
    });
    const projectCapBytes = (project?.maxAttachmentMb ?? 100) * 1024 * 1024;
    if (input.size > projectCapBytes) {
      throw new BadRequestException(
        `File exceeds project cap (${project?.maxAttachmentMb ?? 100} MB). Ask an Admin to raise it in project settings.`,
      );
    }

    const id = randomUUID();
    const slug = slugifyFilename(input.filename);
    const storageKey = `projects/${projectId}/${input.parentType}/${input.parentId}/${id}-${slug}`;
    const putUrl = await this.storage.signedPutUrl(storageKey, input.mimeType, 300);
    return { uploadId: id, storageKey, putUrl, expiresInSeconds: 300 };
  }

  async confirm(actor: AuthenticatedUser, input: {
    uploadId: string;
    storageKey: string;
    parentType: AttachmentParentType;
    parentId: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    visibility?: Visibility;
  }) {
    const exists = await this.storage.exists(input.storageKey);
    if (!exists) throw new BadRequestException('Upload not found in object storage');

    const { projectId, parentVisibility } = await this.resolveParentContext(input.parentType, input.parentId);
    // Client-uploaded files inherit client-visible regardless of incoming flag.
    const visibility: Visibility = actor.kind === 'client'
      ? 'client_visible'
      : input.visibility ?? parentVisibility;

    const att = await this.prisma.attachment.create({
      data: {
        id: input.uploadId,
        parentType: input.parentType,
        parentId: input.parentId,
        projectId,
        uploaderUserId: actor.id,
        originalFilename: input.originalFilename,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        storageKey: input.storageKey,
        visibility,
        scanStatus: 'pending',
      },
    });

    // Enqueue scan (and thumbnail if it's an image).
    await this.scanQueue.add(
      'scan',
      { attachmentId: att.id },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 },
    );
    if (
      input.mimeType.startsWith('image/') ||
      input.mimeType.startsWith('video/') ||
      input.mimeType === 'application/pdf'
    ) {
      await this.thumbQueue.add(
        'thumb',
        { attachmentId: att.id },
        { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 },
      );
    }

    this.events.emit('attachment.uploaded', {
      attachmentId: att.id, projectId, taskId: input.parentType === 'Task' ? input.parentId : undefined,
      actorUserId: actor.id, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
    });
    return att;
  }

  async getDownloadUrl(actor: AuthenticatedUser, id: string): Promise<{ url: string; expiresAt: string }> {
    const att = await this.prisma.attachment.findUnique({ where: { id } });
    if (!att || att.deletedAt) throw new NotFoundException('Attachment not found');
    if (att.scanStatus === 'infected') throw new ForbiddenException('Attachment quarantined');
    if (!(await this.permissions.canSeeTask(actor, att.projectId, att.visibility))) {
      throw new ForbiddenException('No access');
    }
    const url = await this.storage.signedGetUrl(att.storageKey, 900);
    return { url, expiresAt: new Date(Date.now() + 900 * 1000).toISOString() };
  }

  async list(actor: AuthenticatedUser, parentType: AttachmentParentType, parentId: string) {
    const { projectId } = await this.resolveParentContext(parentType, parentId);
    const role = await this.permissions.effectiveRole(actor, projectId);
    if (role === null) throw new ForbiddenException('No access');
    return this.prisma.attachment.findMany({
      where: {
        parentType, parentId, deletedAt: null,
        ...(role === 'Client' ? { visibility: 'client_visible' as const } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async softDelete(actor: AuthenticatedUser, id: string) {
    const att = await this.prisma.attachment.findUniqueOrThrow({ where: { id } });
    const isUploader = att.uploaderUserId === actor.id;
    const role = await this.permissions.effectiveRole(actor, att.projectId);
    const isManagerOrAdmin = role === 'Manager' || (actor.kind === 'internal' && actor.companyRole === 'Admin');
    if (!isUploader && !isManagerOrAdmin) throw new ForbiddenException('Cannot delete');
    await this.prisma.attachment.update({
      where: { id }, data: { deletedAt: new Date() },
    });
    this.events.emit('attachment.deleted', { attachmentId: id, projectId: att.projectId, actorUserId: actor.id });
  }

  // --------- helpers ---------

  private async resolveParentContext(
    parentType: AttachmentParentType,
    parentId: string,
  ): Promise<{ projectId: string; parentVisibility: Visibility }> {
    if (parentType === 'Task' || parentType === 'BugReport') {
      const task = await this.prisma.task.findUnique({
        where: { id: parentId },
        select: { projectId: true, visibility: true },
      });
      if (!task) throw new NotFoundException('Parent task not found');
      return { projectId: task.projectId, parentVisibility: task.visibility };
    }
    if (parentType === 'Comment') {
      const comment = await this.prisma.comment.findUnique({
        where: { id: parentId },
        select: { visibility: true, task: { select: { projectId: true } } },
      });
      if (!comment) throw new NotFoundException('Parent comment not found');
      return { projectId: comment.task.projectId, parentVisibility: comment.visibility };
    }
    throw new BadRequestException(`Unsupported parent type ${parentType}`);
  }
}
