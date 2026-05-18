import { Injectable, Logger, Optional } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';

// =============================================================================
// ImportRunsService — bookkeeping + realtime fan-out for every Import Center
// run, regardless of source.
//
// Every source service (CSV / Jira / Linear / GitHub Issues) calls start() at
// the top of an import, increment() once per row processed, and finish() with
// a status. The service is the single place that:
//   1. Writes ImportRun rows to the DB so the UI's "recent runs" table is
//      hydrated from a single source of truth.
//   2. Emits Socket.IO progress updates to the room `import:<runId>` so the
//      frontend progress bar updates without polling.
//
// Constructor-injectable for the NestJS context. The CLI scripts construct
// a thin variant (gateway = undefined) so progress emits are no-ops in the
// terminal path — the CLI prints its own progress.
// =============================================================================

export type ImportSource = 'csv' | 'jira' | 'linear' | 'github_issues';
export type ImportStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface StartRunInput {
  source: ImportSource;
  actorUserId: string;
  /** Set when the destination project is known up-front (CSV). Jira/Linear/GH
   *  start with null and patch via setProject() once the project exists. */
  projectId?: string | null;
  /** Free-form source ref — Linear team key, Jira project key, "owner/repo". */
  sourceRef?: string | null;
  /** Initial total if known. Jira/Linear/GH don't know this until after their
   *  first paginated fetch; they patch via setTotal() once the count is known. */
  totalRows?: number;
  /** Opaque mapping snapshot — replayed on re-run. Versioned by the caller. */
  mappingSnapshot?: unknown;
}

export interface FinishRunInput {
  runId: string;
  status: Exclude<ImportStatus, 'running'>;
  /** Up to ~4kB; longer text is truncated on write. */
  errorSummary?: string | null;
}

@Injectable()
export class ImportRunsService {
  private readonly logger = new Logger(ImportRunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly gateway?: RealtimeGateway,
  ) {}

  /** Begin a new run row. Returns the runId the caller stashes for later
   *  increment()/finish() calls. */
  async start(input: StartRunInput): Promise<string> {
    const row = await this.prisma.importRun.create({
      data: {
        source: input.source,
        actorUserId: input.actorUserId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        ...(input.totalRows ? { totalRows: input.totalRows } : {}),
        status: 'running',
        ...(input.mappingSnapshot !== undefined
          ? { mappingSnapshot: input.mappingSnapshot as object }
          : {}),
      },
      select: { id: true },
    });
    this.emitProgress(row.id, { processed: 0, total: input.totalRows ?? 0 });
    return row.id;
  }

  /** Patch the destination project once a Jira/Linear/GH run has decided
   *  where rows will land. */
  async setProject(runId: string, projectId: string): Promise<void> {
    await this.prisma.importRun.update({
      where: { id: runId },
      data: { projectId },
    });
  }

  /** Patch totalRows once the source service has finished its initial fetch
   *  and knows how many rows it'll process. */
  async setTotal(runId: string, totalRows: number): Promise<void> {
    await this.prisma.importRun.update({
      where: { id: runId },
      data: { totalRows },
    });
    this.emitProgress(runId, { processed: 0, total: totalRows });
  }

  /** Increment per-row counters. Buckets each row into exactly one of created /
   *  skipped / errored. Emits a Socket.IO progress event with `processed/total`
   *  so the UI's progress bar advances without polling. */
  async increment(
    runId: string,
    bucket: 'created' | 'skipped' | 'errored',
    by = 1,
  ): Promise<void> {
    const field =
      bucket === 'created' ? 'createdRows' : bucket === 'skipped' ? 'skippedRows' : 'erroredRows';
    const row = await this.prisma.importRun.update({
      where: { id: runId },
      data: { [field]: { increment: by } },
      select: { createdRows: true, skippedRows: true, erroredRows: true, totalRows: true },
    });
    const processed = row.createdRows + row.skippedRows + row.erroredRows;
    this.emitProgress(runId, { processed, total: row.totalRows });
  }

  /** Mark the run finished. Caller decides 'succeeded' | 'failed' | 'cancelled'. */
  async finish(input: FinishRunInput): Promise<void> {
    const summary = input.errorSummary?.slice(0, 4000) ?? null;
    const row = await this.prisma.importRun.update({
      where: { id: input.runId },
      data: {
        status: input.status,
        finishedAt: new Date(),
        ...(summary ? { errorSummary: summary } : {}),
      },
      select: { createdRows: true, skippedRows: true, erroredRows: true, totalRows: true },
    });
    const processed = row.createdRows + row.skippedRows + row.erroredRows;
    this.emitDone(input.runId, {
      processed,
      total: row.totalRows,
      status: input.status,
      ...(summary ? { errorSummary: summary } : {}),
    });
  }

  /** Read the last N runs for the workspace, newest first. */
  async listRecent(limit = 20): Promise<unknown[]> {
    return this.prisma.importRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      include: {
        actor: { select: { id: true, name: true, email: true, avatarUrl: true } },
        project: { select: { id: true, key: true, name: true } },
      },
    });
  }

  /** Single-row read for the re-run affordance. Returns null if missing. */
  async get(runId: string): Promise<unknown | null> {
    return this.prisma.importRun.findUnique({
      where: { id: runId },
      include: {
        actor: { select: { id: true, name: true, email: true, avatarUrl: true } },
        project: { select: { id: true, key: true, name: true } },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Socket.IO fan-out. Both events go to the room `import:<runId>` — the
  // frontend joins this room as soon as it gets a runId back from a /run call.
  // ---------------------------------------------------------------------------

  private emitProgress(runId: string, payload: { processed: number; total: number }): void {
    if (!this.gateway?.server) return;
    try {
      this.gateway.server
        .to(`import:${runId}`)
        .emit('import.progress', { runId, ...payload });
    } catch (err) {
      this.logger.warn({ err, runId }, 'progress emit failed');
    }
  }

  private emitDone(
    runId: string,
    payload: { processed: number; total: number; status: ImportStatus; errorSummary?: string },
  ): void {
    if (!this.gateway?.server) return;
    try {
      this.gateway.server.to(`import:${runId}`).emit('import.done', { runId, ...payload });
    } catch (err) {
      this.logger.warn({ err, runId }, 'done emit failed');
    }
  }
}
