import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job } from 'bullmq';
import { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
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
  ) {
    super();
  }

  async process(job: Job<ExportJobPayload>): Promise<void> {
    const { runId } = job.data;
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

    await this.prisma.exportRun.update({
      where: { id: run.id },
      data: { status: 'running' },
    });

    try {
      const { columns, rows } = await this.loadRows(sourceKind, sourceId);
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

      // Email delivery. If the project has an email module we'd call it
      // here; for now we look for the auth-side MailService at runtime and
      // fall back to a TODO comment + log.
      if (schedule?.deliveryKind === 'email' && schedule.deliveryEmailNew) {
        // TODO(R6): wire to email module. The auth/mail.service exists but
        // is private to the auth flow; centralising into apps/api/src/
        // modules/email/ is a separate pass. For now we log the URL so a
        // dev still has a way to retrieve it.
        this.logger.log(
          { runId: run.id, to: schedule.deliveryEmailNew, signedUrl },
          'export.email_delivery_pending — would email signed URL to recipient',
        );
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

  private async loadRows(
    sourceKind: ExportSourceKind,
    sourceId: string | null,
  ): Promise<{ columns: string[]; rows: Array<Record<string, string | number | null>> }> {
    if (sourceKind === 'saved_view') {
      // internal: not reached from an HTTP request — BullMQ processor; failure marks the job failed.
      if (!sourceId) throw new Error('saved_view source requires sourceId');
      const view = await this.prisma.savedSearch.findUnique({ where: { id: sourceId } });
      // internal: not reached from an HTTP request — BullMQ processor; failure marks the job failed.
      if (!view) throw new Error(`Saved view ${sourceId} no longer exists`);
      // Saved views own free-form query JSON the FE understands. For the
      // export we don't try to replay the FE's filter — we read the
      // documented `projectId` / `assigneeUserId` / `status` fields the FE
      // writes most commonly and pass the rest through unfiltered. A
      // future pass should share the FE's query AST with the API so the
      // FE-visible rows match the exported rows 1:1.
      const q = (view.query ?? {}) as Record<string, unknown>;
      const where = pickTaskFilters(q);
      const tasks = await this.prisma.task.findMany({
        where,
        orderBy: [{ projectId: 'asc' }, { keyNumber: 'asc' }],
        take: 10_000,
        include: { assignee: { select: { email: true, name: true } }, project: { select: { key: true, name: true } } },
      });
      return { columns: defaultTaskColumns(), rows: tasks.map(taskToRow) };
    }
    if (sourceKind === 'project') {
      // internal: not reached from an HTTP request — BullMQ processor; failure marks the job failed.
      if (!sourceId) throw new Error('project source requires sourceId');
      const project = await this.prisma.project.findUnique({ where: { id: sourceId } });
      // internal: not reached from an HTTP request — BullMQ processor; failure marks the job failed.
      if (!project) throw new Error(`Project ${sourceId} not found`);
      const tasks = await this.prisma.task.findMany({
        where: { projectId: sourceId },
        orderBy: { keyNumber: 'asc' },
        take: 10_000,
        include: { assignee: { select: { email: true, name: true } }, project: { select: { key: true, name: true } } },
      });
      return { columns: defaultTaskColumns(), rows: tasks.map(taskToRow) };
    }
    // all_tasks
    const tasks = await this.prisma.task.findMany({
      orderBy: [{ projectId: 'asc' }, { keyNumber: 'asc' }],
      take: 10_000,
      include: { assignee: { select: { email: true, name: true } }, project: { select: { key: true, name: true } } },
    });
    return { columns: defaultTaskColumns(), rows: tasks.map(taskToRow) };
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
