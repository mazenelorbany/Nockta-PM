import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job } from 'bullmq';

import { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { MailService } from '../auth/mail.service';
import type { AuthenticatedUser } from '../auth/types';
import { PermissionsService } from '../permissions/permissions.service';

import {
  EXPORTS_QUEUE,
  EXPORT_SIGNED_URL_TTL_SECONDS,
  type ExportJobPayload,
  type ExportKind,
  type ExportSourceKind,
} from './exports.service';
import { renderCsv } from './serializers/csv';
import { renderXlsx } from './serializers/xlsx';
import { renderPdf } from './serializers/pdf';

// =============================================================================
// ExportsProcessor — BullMQ worker that actually materialises an export.
//
// Lifecycle:
//   1. job arrives carrying a runId.
//   2. load the run + the parent schedule (if any) from Postgres. Job
//      payloads are intentionally narrow — Postgres is the truth.
//   3. fetch the source rows (savedView → SavedSearch.query; project →
//      every task in the project; all_tasks → workspace-wide).
//   4. serialise to the chosen kind via one of the renderers in ./serializers.
//      CSV is hand-rolled; XLSX/PDF are gated behind optional npm deps and
//      throw a graceful "install <pkg>" error if the dep is missing.
//   5. upload to S3 if S3_BUCKET-style storage is configured; otherwise drop
//      the file in LOCAL_EXPORT_DIR/<runId> and stamp an /exports/:runId
//      /download URL on the run.
//   6. flip the run to 'completed' + emit 'export.completed' so the email
//      delivery path (TODO: real email module) can fire on it.
// =============================================================================

export const LOCAL_EXPORT_DIR = '/tmp/nockta-exports';

const CONCURRENCY = 2;

@Processor(EXPORTS_QUEUE, { concurrency: CONCURRENCY })
export class ExportsProcessor extends WorkerHost {
  private readonly logger = new Logger(ExportsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly events: EventEmitter2,
    private readonly permissions: PermissionsService,
    private readonly mail: MailService,
  ) {
    super();
  }

  async process(job: Job<ExportJobPayload>): Promise<void> {
    const { runId, actorId } = job.data;
    const run = await this.prisma.exportRun.findUnique({ where: { id: runId } });
    if (!run) {
      this.logger.warn(`process: run ${runId} vanished before job started`);
      return;
    }
    // Re-fetch the schedule lazily — runs without a schedule (one-off
    // inline exports) skip this entirely. The schedule carries the source
    // for the run; on a one-off the columns sourceKind/sourceId on the
    // run itself are authoritative.
    const schedule = run.scheduleId
      ? await this.prisma.exportSchedule.findUnique({ where: { id: run.scheduleId } })
      : null;

    const sourceKind = (run.sourceKind ?? schedule?.sourceKind ?? 'all_tasks') as ExportSourceKind;
    const sourceId = run.sourceId ?? schedule?.sourceId ?? null;
    const kind = run.kind as ExportKind;
    const name = schedule?.name ?? `Export ${run.id.slice(0, 8)}`;

    // Re-resolve the actor for defence-in-depth: even if the service-layer
    // gate was bypassed somehow (direct queue insert, replayed job, etc.),
    // we re-load the actor here and refuse to materialise an export they
    // can't read. A NULL actorId means the job was enqueued before 0023
    // or the user was deleted; we fail-closed to avoid leaking data.
    const actor = actorId ? await this.loadActor(actorId) : null;
    if (!actor) {
      const reason = actorId
        ? `actor ${actorId} was deleted or archived before the job ran`
        : 'no actorId on job payload (pre-0023 job?)';
      this.logger.warn(`process: refusing run ${runId} — ${reason}`);
      await this.prisma.exportRun.update({
        where: { id: run.id },
        data: { status: 'failed', errorMessage: 'Actor unavailable at processing time' },
      });
      return;
    }

    await this.prisma.exportRun.update({
      where: { id: run.id },
      data: { status: 'running' },
    });

    try {
      const { columns, rows } = await this.loadRows(actor, sourceKind, sourceId);
      const generatedAt = new Date();
      const buffer = await this.serialise(kind, { name, columns, rows, generatedAt });

      const storageKey = `exports/${run.id}.${kind}`;
      const useS3 = this.isS3Configured();
      let signedUrl: string;
      let persistedStorageKey: string;
      if (useS3) {
        await this.storage.putBuffer(storageKey, buffer, contentTypeFor(kind));
        signedUrl = await this.storage.signedGetUrl(storageKey, EXPORT_SIGNED_URL_TTL_SECONDS);
        persistedStorageKey = storageKey;
      } else {
        // Local-disk fallback for dev / test stacks without an S3 bucket.
        await mkdir(LOCAL_EXPORT_DIR, { recursive: true });
        const localPath = join(LOCAL_EXPORT_DIR, `${run.id}.${kind}`);
        await writeFile(localPath, buffer);
        // The internal route serves this file. We prefix the storageKey
        // with `local:` so the controller knows it's not an S3 key (see
        // the safety check in ExportsController.downloadLocal).
        persistedStorageKey = `local:${localPath}`;
        signedUrl = `${Env.APP_URL_API}/exports/${run.id}/download`;
      }

      const expiresAt = new Date(generatedAt.getTime() + EXPORT_SIGNED_URL_TTL_SECONDS * 1000);
      const completed = await this.prisma.exportRun.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          storageKey: persistedStorageKey,
          signedUrl,
          fileSize: buffer.byteLength,
          rowCount: rows.length,
          expiresAt,
          completedAt: generatedAt,
        },
      });

      // Email delivery. Sends the signed download URL to the recipient
      // configured on the schedule. Failures are logged but don't fail the
      // run — the file is already persisted and reachable via the URL or
      // the API; an SMTP outage shouldn't roll back a successful export.
      if (schedule?.deliveryKind === 'email' && schedule.deliveryEmailNew) {
        const expiresHours = Math.round(EXPORT_SIGNED_URL_TTL_SECONDS / 3600);
        const sizeKb = Math.max(1, Math.round(buffer.byteLength / 1024));
        try {
          await this.mail.send({
            to: schedule.deliveryEmailNew,
            subject: `Your ${kind.toUpperCase()} export is ready — ${rows.length} rows`,
            text:
              `Your scheduled export has finished.\n\n` +
              `Rows: ${rows.length}\n` +
              `Size: ${sizeKb} KB\n` +
              `Download (expires in ${expiresHours}h): ${signedUrl}\n\n` +
              `If you didn't expect this email you can safely ignore it.`,
          });
        } catch (err) {
          this.logger.error(
            { runId: run.id, to: schedule.deliveryEmailNew, err },
            'export.email_delivery_failed — file is persisted but the recipient did not get the link',
          );
        }
      }

      this.events.emit('export.completed', {
        runId: completed.id,
        scheduleId: completed.scheduleId,
        kind,
        rowCount: rows.length,
        signedUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`export ${runId} failed: ${message}`);
      await this.prisma.exportRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          errorMessage: message.slice(0, 1000),
          errorSummary: message.slice(0, 1000),
          completedAt: new Date(),
        },
      });
      this.events.emit('export.failed', {
        runId: run.id,
        scheduleId: run.scheduleId,
        message,
      });
      throw err;
    }
  }

  // ---- source loaders -----------------------------------------------------

  /**
   * Materialise the source rows the export is over. Every branch enforces
   * the actor's access at this layer too, even though the service layer
   * also gated it — defence-in-depth covers direct queue inserts and
   * replayed jobs where the service gate may not have run.
   */
  private async loadRows(
    actor: AuthenticatedUser,
    sourceKind: ExportSourceKind,
    sourceId: string | null,
  ): Promise<{ columns: string[]; rows: Array<Record<string, string | number | null>> }> {
    const isAdmin = actor.companyRole === 'Admin';

    if (sourceKind === 'saved_view') {
      if (!sourceId) throw new Error('saved_view source requires sourceId');
      const view = await this.prisma.savedSearch.findUnique({ where: { id: sourceId } });
      if (!view) throw new Error(`Saved view ${sourceId} no longer exists`);
      if (!isAdmin && view.userId !== actor.id) {
        throw new Error(`Actor ${actor.id} cannot read saved view ${sourceId}`);
      }
      // Saved views own free-form query JSON the FE understands.
      const q = (view.query ?? {}) as Record<string, unknown>;
      const baseWhere = pickTaskFilters(q);
      // Constrain the result set to the actor's accessible projects to
      // prevent a saved view from referencing a project the actor no
      // longer has access to.
      const accessible = await this.accessibleProjectIds(actor);
      const where = isAdmin
        ? baseWhere
        : { AND: [baseWhere, { projectId: { in: accessible } }] };
      const tasks = await this.prisma.task.findMany({
        where,
        orderBy: [{ projectId: 'asc' }, { keyNumber: 'asc' }],
        take: 10_000,
        include: { assignee: { select: { email: true, name: true } }, project: { select: { key: true, name: true } } },
      });
      return { columns: defaultTaskColumns(), rows: tasks.map(taskToRow) };
    }
    if (sourceKind === 'project') {
      if (!sourceId) throw new Error('project source requires sourceId');
      const project = await this.prisma.project.findUnique({ where: { id: sourceId } });
      if (!project) throw new Error(`Project ${sourceId} not found`);
      // Re-assert at processor layer.
      await this.permissions.assertAtLeast(actor, sourceId, 'Viewer');
      const tasks = await this.prisma.task.findMany({
        where: { projectId: sourceId },
        orderBy: { keyNumber: 'asc' },
        take: 10_000,
        include: { assignee: { select: { email: true, name: true } }, project: { select: { key: true, name: true } } },
      });
      return { columns: defaultTaskColumns(), rows: tasks.map(taskToRow) };
    }
    // all_tasks: filter by the actor's accessible projects.
    const where = isAdmin
      ? undefined
      : { projectId: { in: await this.accessibleProjectIds(actor) } };
    const tasks = await this.prisma.task.findMany({
      ...(where ? { where } : {}),
      orderBy: [{ projectId: 'asc' }, { keyNumber: 'asc' }],
      take: 10_000,
      include: { assignee: { select: { email: true, name: true } }, project: { select: { key: true, name: true } } },
    });
    return { columns: defaultTaskColumns(), rows: tasks.map(taskToRow) };
  }

  /**
   * Hydrate the actor by id. Returns null if the user is gone or archived
   * (in which case the processor refuses the job).
   */
  private async loadActor(id: string): Promise<AuthenticatedUser | null> {
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, kind: true, companyRole: true, archivedAt: true },
    });
    if (!u || u.archivedAt) return null;
    return { id: u.id, email: u.email, kind: u.kind, companyRole: u.companyRole } as AuthenticatedUser;
  }

  /**
   * Resolve every projectId the actor has at-least-Viewer access to. Mirrors
   * the helper in SearchService / ReportsService — duplicated here rather
   * than imported because the data model is single-tenant and the helper
   * is small enough to stay local.
   */
  private async accessibleProjectIds(actor: AuthenticatedUser): Promise<string[]> {
    if (actor.companyRole === 'Admin') {
      const all = await this.prisma.project.findMany({ select: { id: true } });
      return all.map((p) => p.id);
    }
    const direct = await this.prisma.projectAccess.findMany({
      where: { OR: [{ userId: actor.id }, { team: { members: { some: { userId: actor.id } } } }] },
      select: { projectId: true },
    });
    const publicProjects = await this.prisma.project.findMany({
      where: { visibility: 'public' },
      select: { id: true },
    });
    return Array.from(new Set([
      ...direct.map((d) => d.projectId),
      ...publicProjects.map((p) => p.id),
    ]));
  }

  // ---- serialiser delegation ---------------------------------------------

  private async serialise(
    kind: ExportKind,
    args: {
      name: string;
      columns: string[];
      rows: Array<Record<string, string | number | null>>;
      generatedAt: Date;
    },
  ): Promise<Buffer> {
    if (kind === 'csv') return renderCsv(args.columns, args.rows);
    if (kind === 'xlsx') return renderXlsx(args.name, args.columns, args.rows);
    if (kind === 'pdf') return renderPdf(args.name, args.columns, args.rows, args.generatedAt);
    // internal: not reached from an HTTP request — BullMQ processor; failure marks the job failed.
    throw new Error(`Unknown export kind: ${kind}`);
  }

  // ---- env probes --------------------------------------------------------

  private isS3Configured(): boolean {
    // Treat the bucket name as the discriminator. The Env loader requires a
    // value so it's always set, but in dev that value points at MinIO. We
    // additionally guard on NODE_ENV=production OR an explicitly opt-in env
    // flag because storing dev exports in MinIO is fine but pre-signed URLs
    // against the local docker network aren't reachable from the browser
    // on the host's IP. Setting EXPORTS_USE_S3=true forces the S3 path.
    if (process.env.EXPORTS_USE_S3 === 'true') return true;
    if (Env.NODE_ENV !== 'production') return false;
    return Boolean(Env.S3_BUCKET);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function defaultTaskColumns(): string[] {
  return [
    'project',
    'key',
    'title',
    'type',
    'status',
    'priority',
    'assignee',
    'reporter',
    'dueDate',
    'estimate',
    'createdAt',
  ];
}

function taskToRow(t: {
  id: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  keyNumber: number;
  dueDate: Date | null;
  estimate: number | null;
  createdAt: Date;
  assignee?: { name: string | null; email: string } | null;
  project?: { key: string; name: string } | null;
  reporterUserId: string;
}): Record<string, string | number | null> {
  const projectLabel = t.project ? t.project.name : '';
  const key = t.project ? `${t.project.key}-${t.keyNumber}` : String(t.keyNumber);
  const assignee = t.assignee?.name ?? t.assignee?.email ?? '';
  return {
    project: projectLabel,
    key,
    title: t.title,
    type: t.type,
    status: t.status,
    priority: t.priority,
    assignee,
    reporter: t.reporterUserId,
    dueDate: t.dueDate ? t.dueDate.toISOString() : '',
    estimate: t.estimate ?? '',
    createdAt: t.createdAt.toISOString(),
  };
}

function pickTaskFilters(q: Record<string, unknown>): Record<string, unknown> {
  // Defensive subset — only the keys we know how to translate to a Prisma
  // `where`. Unknown keys are ignored rather than passed through (which
  // would let a malicious saved-view query inject arbitrary clauses).
  const where: Record<string, unknown> = {};
  if (typeof q.projectId === 'string') where.projectId = q.projectId;
  if (typeof q.assigneeUserId === 'string') where.assigneeUserId = q.assigneeUserId;
  if (typeof q.status === 'string') where.status = q.status;
  if (Array.isArray(q.statuses) && q.statuses.every((s) => typeof s === 'string')) {
    where.status = { in: q.statuses };
  }
  if (typeof q.priority === 'string') where.priority = q.priority;
  return where;
}

function contentTypeFor(kind: ExportKind): string {
  if (kind === 'csv') return 'text/csv; charset=utf-8';
  if (kind === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/pdf';
}
