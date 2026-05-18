import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { StorageService } from '../storage/storage.service';
import type { AuthenticatedUser } from '../auth/types';

import { AttachmentsService } from './attachments.service';

// =============================================================================
// attachments.service — signed-URL upload + confirm + download flow. The
// concrete tests here pin the security claims that matter:
//
//   - Viewers can never upload.
//   - Per-project size cap is enforced before we hand out a URL.
//   - Blocked extensions never make it past sign().
//   - Confirm refuses if the object isn't actually in S3.
//   - Guest-uploaded files inherit client_visible regardless of the flag the
//     client sent — preventing a guest from sneaking an internal upload.
//   - Download URLs require the canSeeTask check to pass; quarantined files
//     never return a URL.
// =============================================================================

interface AttachmentMocks {
  prisma: PrismaService;
  storage: { signedPutUrl: ReturnType<typeof vi.fn>; signedGetUrl: ReturnType<typeof vi.fn>; exists: ReturnType<typeof vi.fn> };
  permissions: {
    effectiveRole: ReturnType<typeof vi.fn>;
    canSeeTask: ReturnType<typeof vi.fn>;
  };
  scanQueue: { add: ReturnType<typeof vi.fn> };
  thumbQueue: { add: ReturnType<typeof vi.fn> };
}

function build(): { service: AttachmentsService; mocks: AttachmentMocks } {
  const prisma = makePrismaMock();
  const storage = {
    signedPutUrl: vi.fn().mockResolvedValue('https://s3.test/put?sig=1'),
    signedGetUrl: vi.fn().mockResolvedValue('https://s3.test/get?sig=1'),
    exists: vi.fn().mockResolvedValue(true),
  };
  const permissions = {
    effectiveRole: vi.fn(),
    canSeeTask: vi.fn(),
  };
  const scanQueue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
  const thumbQueue = { add: vi.fn().mockResolvedValue({ id: 'job-2' }) };
  const events = makeEventsMock();

  const service = new AttachmentsService(
    prisma,
    storage as unknown as StorageService,
    permissions as unknown as PermissionsService,
    events.instance,
    scanQueue as never,
    thumbQueue as never,
  );

  return { service, mocks: { prisma, storage, permissions, scanQueue, thumbQueue } };
}

function buildActor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'user-1',
    email: 'someone@nockta.com',
    kind: 'internal',
    companyRole: 'Member',
    ...overrides,
  } as AuthenticatedUser;
}

describe('AttachmentsService.sign', () => {
  it('blocks executable extensions before computing a URL', async () => {
    const { service, mocks } = build();
    await expect(
      service.sign(buildActor(), {
        parentType: 'Task',
        parentId: 'task-1',
        filename: 'payload.exe',
        mimeType: 'application/octet-stream',
        size: 1024,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mocks.storage.signedPutUrl).not.toHaveBeenCalled();
  });

  it('blocks the double-extension trick (foo.pdf.exe)', async () => {
    const { service, mocks } = build();
    await expect(
      service.sign(buildActor(), {
        parentType: 'Task',
        parentId: 'task-1',
        filename: 'innocent.pdf.exe',
        mimeType: 'application/pdf',
        size: 1024,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mocks.storage.signedPutUrl).not.toHaveBeenCalled();
  });

  it('rejects upload size of 0 or negative', async () => {
    const { service } = build();
    await expect(
      service.sign(buildActor(), {
        parentType: 'Task',
        parentId: 'task-1',
        filename: 'empty.txt',
        mimeType: 'text/plain',
        size: 0,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects Viewers from uploading', async () => {
    const { service, mocks } = build();
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p1',
      visibility: 'internal',
    } as never);
    mocks.permissions.effectiveRole.mockResolvedValueOnce('Viewer');

    await expect(
      service.sign(buildActor(), {
        parentType: 'Task',
        parentId: 'task-1',
        filename: 'spec.pdf',
        mimeType: 'application/pdf',
        size: 1024,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(mocks.storage.signedPutUrl).not.toHaveBeenCalled();
  });

  it('rejects users without any project access', async () => {
    const { service, mocks } = build();
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p1',
      visibility: 'internal',
    } as never);
    mocks.permissions.effectiveRole.mockResolvedValueOnce(null);

    await expect(
      service.sign(buildActor(), {
        parentType: 'Task',
        parentId: 'task-1',
        filename: 'spec.pdf',
        mimeType: 'application/pdf',
        size: 1024,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('enforces the per-project size cap', async () => {
    const { service, mocks } = build();
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p1',
      visibility: 'internal',
    } as never);
    mocks.permissions.effectiveRole.mockResolvedValueOnce('Contributor');
    vi.mocked(mocks.prisma.project.findUnique).mockResolvedValueOnce({
      maxAttachmentMb: 10,
    } as never);

    await expect(
      service.sign(buildActor(), {
        parentType: 'Task',
        parentId: 'task-1',
        filename: 'big.zip',
        mimeType: 'application/zip',
        size: 11 * 1024 * 1024, // 11 MB > 10 MB cap
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mocks.storage.signedPutUrl).not.toHaveBeenCalled();
  });

  it('returns a signed URL + storage key when checks pass', async () => {
    const { service, mocks } = build();
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'project-uuid',
      visibility: 'internal',
    } as never);
    mocks.permissions.effectiveRole.mockResolvedValueOnce('Contributor');
    vi.mocked(mocks.prisma.project.findUnique).mockResolvedValueOnce({
      maxAttachmentMb: 100,
    } as never);

    const result = await service.sign(buildActor(), {
      parentType: 'Task',
      parentId: 'task-uuid',
      filename: 'design-spec.pdf',
      mimeType: 'application/pdf',
      size: 2 * 1024 * 1024,
    });

    expect(result.putUrl).toBe('https://s3.test/put?sig=1');
    // storageKey contains the project + parent identifiers and a slugged
    // filename — pins the convention attachments.processor relies on.
    expect(result.storageKey).toMatch(
      /^projects\/project-uuid\/Task\/task-uuid\/.+\.pdf$/,
    );
    expect(result.expiresInSeconds).toBe(300);
    expect(mocks.storage.signedPutUrl).toHaveBeenCalledOnce();
  });
});

describe('AttachmentsService.confirm', () => {
  function stubParent(mocks: AttachmentMocks) {
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p1',
      visibility: 'internal',
    } as never);
  }

  it('refuses to record an attachment that does not actually exist in S3', async () => {
    // Guards against a malicious client calling /confirm without ever calling
    // /sign — otherwise we'd persist a DB row pointing at nothing.
    const { service, mocks } = build();
    mocks.storage.exists.mockResolvedValueOnce(false);

    await expect(
      service.confirm(buildActor(), {
        uploadId: 'upload-1',
        storageKey: 'projects/p/Task/t/missing.pdf',
        parentType: 'Task',
        parentId: 'task-1',
        originalFilename: 'missing.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mocks.prisma.attachment.create).not.toHaveBeenCalled();
  });

  it('persists with parent visibility for internal users by default', async () => {
    const { service, mocks } = build();
    mocks.storage.exists.mockResolvedValueOnce(true);
    stubParent(mocks);
    vi.mocked(mocks.prisma.attachment.create).mockResolvedValueOnce({
      id: 'att-1',
      visibility: 'internal',
    } as never);

    await service.confirm(buildActor(), {
      uploadId: 'upload-1',
      storageKey: 'projects/p1/Task/task-1/file.pdf',
      parentType: 'Task',
      parentId: 'task-1',
      originalFilename: 'file.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
    });

    const createArgs = vi.mocked(mocks.prisma.attachment.create).mock.calls[0]?.[0];
    expect(createArgs?.data?.visibility).toBe('internal');
    expect(createArgs?.data?.scanStatus).toBe('pending');
  });

  it("forces client_visible when a guest uploads, regardless of incoming flag", async () => {
    // A guest can never elevate their own upload to internal. The incoming
    // `visibility: 'internal'` should be ignored — otherwise a guest could
    // hide their upload from other guests on the same project.
    const { service, mocks } = build();
    mocks.storage.exists.mockResolvedValueOnce(true);
    stubParent(mocks);
    vi.mocked(mocks.prisma.attachment.create).mockResolvedValueOnce({
      id: 'att-1',
      visibility: 'client_visible',
    } as never);

    await service.confirm(buildActor({ kind: 'client', companyRole: null }), {
      uploadId: 'upload-1',
      storageKey: 'projects/p1/Task/task-1/file.pdf',
      parentType: 'Task',
      parentId: 'task-1',
      originalFilename: 'file.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      visibility: 'internal', // <-- attempted elevation
    });

    const createArgs = vi.mocked(mocks.prisma.attachment.create).mock.calls[0]?.[0];
    expect(createArgs?.data?.visibility).toBe('client_visible');
  });

  it('enqueues a scan job + emits attachment.uploaded', async () => {
    const { service, mocks } = build();
    mocks.storage.exists.mockResolvedValueOnce(true);
    stubParent(mocks);
    vi.mocked(mocks.prisma.attachment.create).mockResolvedValueOnce({
      id: 'att-1',
      visibility: 'internal',
    } as never);

    await service.confirm(buildActor(), {
      uploadId: 'upload-1',
      storageKey: 'projects/p1/Task/task-1/file.txt',
      parentType: 'Task',
      parentId: 'task-1',
      originalFilename: 'file.txt',
      mimeType: 'text/plain',
      sizeBytes: 100,
    });

    expect(mocks.scanQueue.add).toHaveBeenCalledOnce();
    expect(mocks.thumbQueue.add).not.toHaveBeenCalled(); // plain text — no thumb
  });

  it('enqueues a thumbnail job for image MIME types', async () => {
    const { service, mocks } = build();
    mocks.storage.exists.mockResolvedValueOnce(true);
    stubParent(mocks);
    vi.mocked(mocks.prisma.attachment.create).mockResolvedValueOnce({
      id: 'att-1',
      visibility: 'internal',
    } as never);

    await service.confirm(buildActor(), {
      uploadId: 'upload-1',
      storageKey: 'projects/p1/Task/task-1/screenshot.png',
      parentType: 'Task',
      parentId: 'task-1',
      originalFilename: 'screenshot.png',
      mimeType: 'image/png',
      sizeBytes: 100,
    });

    expect(mocks.scanQueue.add).toHaveBeenCalledOnce();
    expect(mocks.thumbQueue.add).toHaveBeenCalledOnce();
  });
});

describe('AttachmentsService.getDownloadUrl', () => {
  let mocks: AttachmentMocks;
  let service: AttachmentsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('returns 404 for a missing attachment', async () => {
    vi.mocked(mocks.prisma.attachment.findUnique).mockResolvedValueOnce(null);
    await expect(service.getDownloadUrl(buildActor(), 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns 404 for a soft-deleted attachment', async () => {
    vi.mocked(mocks.prisma.attachment.findUnique).mockResolvedValueOnce({
      id: 'att-1',
      deletedAt: new Date(),
      projectId: 'p1',
      visibility: 'internal',
      scanStatus: 'clean',
    } as never);

    await expect(service.getDownloadUrl(buildActor(), 'att-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuses to serve quarantined attachments', async () => {
    // Critical: a malicious upload caught by ClamAV must never be downloadable.
    vi.mocked(mocks.prisma.attachment.findUnique).mockResolvedValueOnce({
      id: 'att-1',
      deletedAt: null,
      projectId: 'p1',
      visibility: 'internal',
      scanStatus: 'infected',
      storageKey: 'projects/p1/Task/t/x.exe',
    } as never);

    await expect(service.getDownloadUrl(buildActor(), 'att-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(mocks.storage.signedGetUrl).not.toHaveBeenCalled();
  });

  it('refuses to serve attachments the actor cannot see', async () => {
    vi.mocked(mocks.prisma.attachment.findUnique).mockResolvedValueOnce({
      id: 'att-1',
      deletedAt: null,
      projectId: 'p1',
      visibility: 'internal',
      scanStatus: 'clean',
      storageKey: 'projects/p1/Task/t/secret.pdf',
    } as never);
    mocks.permissions.canSeeTask.mockResolvedValueOnce(false);

    await expect(
      service.getDownloadUrl(buildActor({ kind: 'client' }), 'att-1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns a signed URL with a future expiry when access checks pass', async () => {
    vi.mocked(mocks.prisma.attachment.findUnique).mockResolvedValueOnce({
      id: 'att-1',
      deletedAt: null,
      projectId: 'p1',
      visibility: 'internal',
      scanStatus: 'clean',
      storageKey: 'projects/p1/Task/t/spec.pdf',
    } as never);
    mocks.permissions.canSeeTask.mockResolvedValueOnce(true);

    const result = await service.getDownloadUrl(buildActor(), 'att-1');
    expect(result.url).toBe('https://s3.test/get?sig=1');
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(mocks.storage.signedGetUrl).toHaveBeenCalledWith(
      'projects/p1/Task/t/spec.pdf',
      900,
    );
  });
});
