import { randomBytes, createHash } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma} from '@prisma/client';
import { type DeploymentSource } from '@prisma/client';
import { generateKeyBetween } from 'fractional-indexing';

import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import type { NormalizedDeployment } from './source-adapters';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

@Injectable()
export class DeploymentsService {
  private readonly logger = new Logger(DeploymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  // ----- secret management -----

  async getSecretHash(projectId: string, source: DeploymentSource): Promise<string | null> {
    const row = await this.prisma.projectDeploymentSecret.findUnique({
      where: { projectId_source: { projectId, source } },
    });
    return row?.secretHash ?? null;
  }

  async rotateSecret(
    actor: AuthenticatedUser,
    projectId: string,
    source: DeploymentSource,
  ): Promise<{ secret: string }> {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const secret = randomBytes(32).toString('base64url');
    await this.prisma.projectDeploymentSecret.upsert({
      where: { projectId_source: { projectId, source } },
      update: { secretHash: sha256(secret), rotatedAt: new Date() },
      create: { projectId, source, secretHash: sha256(secret) },
    });
    return { secret };
  }

  // ----- ingest -----

  async record(projectId: string, normalized: NormalizedDeployment): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, archivedAt: true, workflowPreset: true },
    });
    if (!project || project.archivedAt) return;

    const deployment = await this.prisma.deployment.upsert({
      where: {
        // Use the (source, externalId) tuple via a custom unique key — but Prisma needs a single field for `where`.
        // Use a deterministic id derived from the externalId + source instead.
        id: deterministicId(normalized.source, normalized.externalId),
      },
      update: {
        status: normalized.status,
        finishedAt: normalized.finishedAt,
        ...(normalized.commitSha ? { commitSha: normalized.commitSha } : {}),
        ...(normalized.commitMessage ? { commitMessage: normalized.commitMessage } : {}),
        ...(normalized.url ? { url: normalized.url } : {}),
        metadata: normalized.raw as Prisma.InputJsonValue,
        rawPayload: normalized.raw as Prisma.InputJsonValue,
      },
      create: {
        id: deterministicId(normalized.source, normalized.externalId),
        projectId,
        source: normalized.source,
        environment: normalized.environment,
        status: normalized.status,
        ...(normalized.commitSha ? { commitSha: normalized.commitSha } : {}),
        ...(normalized.commitMessage ? { commitMessage: normalized.commitMessage } : {}),
        ...(normalized.url ? { url: normalized.url } : {}),
        startedAt: normalized.startedAt,
        finishedAt: normalized.finishedAt,
        metadata: normalized.raw as Prisma.InputJsonValue,
        rawPayload: normalized.raw as Prisma.InputJsonValue,
      },
    });

    // Link to tasks by commit SHA (via existing TaskGithubLinks).
    let linkedTaskIds: string[] = [];
    if (normalized.commitSha) {
      const links = await this.prisma.taskGithubLink.findMany({
        where: { commitSha: normalized.commitSha },
        select: { taskId: true, task: { select: { projectId: true } } },
      });
      linkedTaskIds = links
        .filter((l) => l.task.projectId === projectId)
        .map((l) => l.taskId);
      for (const taskId of linkedTaskIds) {
        await this.prisma.taskDeployment.upsert({
          where: { taskId_deploymentId: { taskId, deploymentId: deployment.id } },
          update: {},
          create: { taskId, deploymentId: deployment.id },
        });
      }
    }

    // Auto-status: production succeeded → Testing → Done (Engineering preset only).
    if (
      normalized.status === 'succeeded' &&
      normalized.environment === 'production' &&
      project.workflowPreset === 'engineering' &&
      linkedTaskIds.length > 0
    ) {
      for (const taskId of linkedTaskIds) {
        const task = await this.prisma.task.findUnique({ where: { id: taskId } });
        if (!task || task.status !== 'Testing') continue;
        const last = await this.prisma.task.findFirst({
          where: { projectId, status: 'Done' },
          orderBy: { boardPosition: 'desc' },
          select: { boardPosition: true },
        });
        const boardPosition = generateKeyBetween(last?.boardPosition ?? null, null);
        await this.prisma.task.update({
          where: { id: taskId },
          data: { status: 'Done', boardPosition },
        });
        this.events.emit('task.status_changed', {
          taskId,
          projectId,
          fromStatus: 'Testing',
          toStatus: 'Done',
          triggeredBy: 'deployment',
          actorUserId: null,
        });
      }
    }

    // Domain events
    const baseEvent = { deploymentId: deployment.id, projectId, environment: normalized.environment, source: normalized.source, commitSha: normalized.commitSha, linkedTaskIds };
    switch (normalized.status) {
      case 'started':
        this.events.emit('deploy.started', baseEvent);
        break;
      case 'succeeded':
        this.events.emit('deploy.succeeded', baseEvent);
        if (normalized.environment === 'production') {
          this.events.emit('deploy.production_release', baseEvent);
        }
        break;
      case 'failed':
        this.events.emit('deploy.failed', baseEvent);
        break;
      case 'rolled_back':
        this.events.emit('deploy.rolled_back', baseEvent);
        break;
    }
  }

  // ----- queries -----

  async listForProject(actor: AuthenticatedUser, projectId: string, limit = 30) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    const clamped = Math.min(100, Math.max(1, Math.floor(limit) || 30));
    // Include the linked-task count so the UI can show "N tasks linked"
    // without a second query. The Deployment row itself has no `deployedBy`
    // user column — that information lives only in `rawPayload` (e.g. the
    // GitHub `creator.login` field), so the frontend renders the source as
    // a chip rather than an avatar+name pair.
    const rows = await this.prisma.deployment.findMany({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
      take: clamped,
      include: {
        _count: { select: { tasks: true } },
      },
    });
    return rows.map((d) => ({
      id: d.id,
      source: d.source,
      status: d.status,
      environment: d.environment,
      commitSha: d.commitSha,
      commitMessage: d.commitMessage,
      url: d.url,
      startedAt: d.startedAt,
      finishedAt: d.finishedAt,
      taskCount: d._count.tasks,
    }));
  }

  async get(actor: AuthenticatedUser, id: string) {
    const d = await this.prisma.deployment.findUnique({
      where: { id },
      include: { tasks: { include: { task: { select: { id: true, title: true, status: true, keyNumber: true } } } } },
    });
    if (!d) throw new NotFoundException();
    await this.permissions.assertAtLeast(actor, d.projectId, 'Viewer');
    return d;
  }
}

/** Build a stable UUID-shaped string from (source + externalId) so upsert works. */
function deterministicId(source: string, externalId: string): string {
  const hash = sha256(`${source}|${externalId}`).slice(0, 32);
  // Format as 8-4-4-4-12 (RFC 4122-ish, version bits not strictly correct but valid as a uuid string).
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
