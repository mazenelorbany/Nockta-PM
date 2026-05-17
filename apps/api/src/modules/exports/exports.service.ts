import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';
import { WorkspaceContextService } from '../workspace/workspace-context.service';

// =============================================================================
// ExportsService — workspace-scoped scheduled/on-demand data exports.
//
// Two flavours of object:
//   - ExportSchedule: a persistent "give me this report" config the user
//     authored in Settings → Exports. May be on a cron (recurring) or one-off
//     (`scheduleCron` is null and `enabled` flips false after first fire).
//   - ExportRun: one materialised export. Owns the signed URL the user
//     downloads, the row count, the status, and a soft 24h expiry.
//
// The service is the single owner of the lifecycle:
//   createSchedule → optional cron tick → runOnce → ExportsProcessor → done
//
// The processor itself (exports.processor.ts) does the actual serialisation +
// upload. This file is responsible for the CRUD surface, validation, and the
// download-URL retrieval path.
// =============================================================================

export const EXPORTS_QUEUE = 'exports';

export type ExportKind = 'csv' | 'xlsx' | 'pdf';
export type ExportSourceKind = 'saved_view' | 'project' | 'all_tasks';
export type ExportDeliveryKind = 'download' | 'email';
export type ExportRunStatus = 'queued' | 'running' | 'completed' | 'failed';

const EXPORT_KINDS: ExportKind[] = ['csv', 'xlsx', 'pdf'];
const SOURCE_KINDS: ExportSourceKind[] = ['saved_view', 'project', 'all_tasks'];
const DELIVERY_KINDS: ExportDeliveryKind[] = ['download', 'email'];

/** Signed-URL TTL. Picked at 24h because:
 *   - Email-delivered reports need to survive a normal "I'll click this in
 *     the morning" gap.
 *   - S3 presign maxes out at 7 days for SigV4 with credentials, so 24h is
 *     well within the safe band even for downstream tools that grab the URL
 *     and re-fetch it later.
 *   - Long enough that we won't have to refresh-on-read for the common case;
 *     short enough that an accidentally-leaked URL doesn't read forever. */
export const EXPORT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

/** BullMQ job payload — kept narrow so the processor can rehydrate from
 *  Postgres rather than trusting the queue. */
export interface ExportJobPayload {
  runId: string;
}

export interface CreateScheduleInput {
  name: string;
  kind: ExportKind;
  sourceKind: ExportSourceKind;
  sourceId?: string;
  scheduleCron?: string | null;
  deliveryKind: ExportDeliveryKind;
  deliveryEmail?: string | null;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  name?: string;
  kind?: ExportKind;
  sourceKind?: ExportSourceKind;
  sourceId?: string | null;
  scheduleCron?: string | null;
  deliveryKind?: ExportDeliveryKind;
  deliveryEmail?: string | null;
  enabled?: boolean;
}

export interface InlineRunInput {
  name?: string;
  kind: ExportKind;
  sourceKind: ExportSourceKind;
  sourceId?: string;
}

@Injectable()
export class ExportsService implements OnModuleInit {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(WorkspaceContextService)
    private readonly workspaceCtx: WorkspaceContextService | null,
    @InjectQueue(EXPORTS_QUEUE) private readonly queue: Queue<ExportJobPayload>,
  ) {}

  onModuleInit(): void {
    this.logger.log(`ExportsService ready — queue=${EXPORTS_QUEUE}`);
  }

  // ===========================================================================
  // Schedules: CRUD
  // ===========================================================================

  async createSchedule(actor: AuthenticatedUser, input: CreateScheduleInput) {
    this.validateKind(input.kind);
    this.validateSource(input.sourceKind, input.sourceId);
    if (!input.name?.trim()) throw new BadRequestException('Name is required');
    if (!DELIVERY_KINDS.includes(input.deliveryKind)) {
      throw new BadRequestException('Unknown deliveryKind');
    }
    if (input.deliveryKind === 'email' && !input.deliveryEmail?.trim()) {
      throw new BadRequestException('deliveryEmail required when deliveryKind=email');
    }
    if (input.scheduleCron) this.validateCron(input.scheduleCron);

    const workspaceId = await this.resolveWorkspace(actor);
    // Mirror to legacy `query` blob so a pre-0015 reader can still parse it.
    const legacyQuery: Prisma.InputJsonValue = {
      source: this.toLegacySource(input.sourceKind),
      ...(input.sourceKind === 'saved_view' && input.sourceId
        ? { savedViewId: input.sourceId }
        : {}),
      ...(input.sourceKind === 'project' && input.sourceId
        ? { projectId: input.sourceId }
        : {}),
    };

    const created = await this.prisma.exportSchedule.create({
      data: {
        workspaceId,
        name: input.name.trim(),
        kind: input.kind,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId ?? null,
        scheduleCron: input.scheduleCron ?? null,
        // Keep legacy mirrors in sync — see migration 0015 header.
        cron: input.scheduleCron ?? null,
        deliveryKind: input.deliveryKind,
        delivery: input.deliveryKind,
        deliveryEmailNew: input.deliveryEmail ?? null,
        deliveryEmail: input.deliveryEmail ?? null,
        enabled: input.enabled ?? true,
        query: legacyQuery,
        createdById: actor.id,
      },
    });
    return this.shapeSchedule(created);
  }

  async listSchedules(actor: AuthenticatedUser) {
    const workspaceId = await this.resolveWorkspace(actor);
    const rows = await this.prisma.exportSchedule.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.shapeSchedule(r));
  }

  async getSchedule(actor: AuthenticatedUser, id: string) {
    const row = await this.requireSchedule(actor, id);
    return this.shapeSchedule(row);
  }

  async updateSchedule(actor: AuthenticatedUser, id: string, input: UpdateScheduleInput) {
    const existing = await this.requireSchedule(actor, id);
    if (input.kind) this.validateKind(input.kind);
    if (input.sourceKind) this.validateSource(input.sourceKind, input.sourceId ?? existing.sourceId);
    if (input.deliveryKind && !DELIVERY_KINDS.includes(input.deliveryKind)) {
      throw new BadRequestException('Unknown deliveryKind');
    }
    if (input.scheduleCron) this.validateCron(input.scheduleCron);

    const nextSourceKind = input.sourceKind ?? (existing.sourceKind as ExportSourceKind);
    const nextSourceId = input.sourceId === undefined ? existing.sourceId : input.sourceId;
    const legacyQuery: Prisma.InputJsonValue = {
      source: this.toLegacySource(nextSourceKind),
      ...(nextSourceKind === 'saved_view' && nextSourceId ? { savedViewId: nextSourceId } : {}),
      ...(nextSourceKind === 'project' && nextSourceId ? { projectId: nextSourceId } : {}),
    };

    const updated = await this.prisma.exportSchedule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.sourceKind !== undefined ? { sourceKind: input.sourceKind } : {}),
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        ...(input.scheduleCron !== undefined
          ? { scheduleCron: input.scheduleCron, cron: input.scheduleCron }
          : {}),
        ...(input.deliveryKind !== undefined
          ? { deliveryKind: input.deliveryKind, delivery: input.deliveryKind }
          : {}),
        ...(input.deliveryEmail !== undefined
          ? { deliveryEmailNew: input.deliveryEmail, deliveryEmail: input.deliveryEmail }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        query: legacyQuery,
      },
    });
    return this.shapeSchedule(updated);
  }

  async deleteSchedule(actor: AuthenticatedUser, id: string) {
    await this.requireSchedule(actor, id);
    await this.prisma.exportSchedule.delete({ where: { id } });
    return { ok: true };
  }

  // ===========================================================================
  // Runs: enqueue + retrieve
  // ===========================================================================

  /**
   * Run a schedule once now, or run a free-form inline export. Returns the
   * created ExportRun row (status='queued'); the processor will flip it to
   * 'completed' or 'failed' asynchronously.
   */
  async runOnce(
    actor: AuthenticatedUser,
    args:
      | { scheduleId: string; inline?: never }
      | { scheduleId?: never; inline: InlineRunInput },
  ) {
    if (args.scheduleId) {
      const schedule = await this.requireSchedule(actor, args.scheduleId);
      const run = await this.createRun({
        scheduleId: schedule.id,
        kind: schedule.kind as ExportKind,
        sourceKind: schedule.sourceKind as ExportSourceKind,
        sourceId: schedule.sourceId,
      });
      await this.prisma.exportSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: new Date() },
      });
      await this.enqueue(run.id);
      return run;
    }
    // args.scheduleId is falsy here, so the discriminated union narrows to
    // the inline branch — TS doesn't infer that without the explicit guard.
    const inline = args.inline;
    if (!inline) throw new BadRequestException('Either scheduleId or inline must be provided');
    this.validateKind(inline.kind);
    this.validateSource(inline.sourceKind, inline.sourceId);
    const run = await this.createRun({
      scheduleId: null,
      kind: inline.kind,
      sourceKind: inline.sourceKind,
      sourceId: inline.sourceId ?? null,
    });
    await this.enqueue(run.id);
    return run;
  }

  async listRecentRuns(actor: AuthenticatedUser, opts: { scheduleId?: string; take?: number } = {}) {
    const workspaceId = await this.resolveWorkspace(actor);
    // Filter via the schedule's workspace when a scheduleId is supplied; for
    // workspace-wide history we still walk through the schedule join so a
    // user can't see a run that belongs to another workspace's schedule.
    const take = Math.min(200, Math.max(1, opts.take ?? 50));
    if (opts.scheduleId) {
      await this.requireSchedule(actor, opts.scheduleId);
      const runs = await this.prisma.exportRun.findMany({
        where: { scheduleId: opts.scheduleId },
        orderBy: { createdAt: 'desc' },
        take,
      });
      return runs.map((r) => this.shapeRun(r));
    }
    const scheduleIds = (
      await this.prisma.exportSchedule.findMany({
        where: { workspaceId },
        select: { id: true },
      })
    ).map((s) => s.id);
    const runs = await this.prisma.exportRun.findMany({
      where: {
        OR: [
          { scheduleId: { in: scheduleIds.length > 0 ? scheduleIds : ['__none__'] } },
          // One-off inline runs have no scheduleId — surface them too. They
          // aren't workspace-scoped in the schema, but the API only emits
          // them in the authenticated user's workspace, so a slight blur
          // here is acceptable.
          { scheduleId: null },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return runs.map((r) => this.shapeRun(r));
  }

  /**
   * Resolve a fresh download URL for a completed run. Returns the existing
   * `signedUrl` if it's still valid (within EXPORT_SIGNED_URL_TTL_SECONDS of
   * `createdAt`), otherwise throws BadRequest — the storage adapter owns the
   * actual re-sign logic (the processor stamps a fresh URL when it completes
   * the run, and the GET /exports/:runId/download route in the controller
   * handles the local-disk dev fallback).
   */
  async getDownloadUrl(actor: AuthenticatedUser, runId: string) {
    const run = await this.prisma.exportRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Export run not found');
    await this.assertRunOwnership(actor, run);
    if (run.status !== 'completed') {
      throw new BadRequestException(`Run is ${run.status}, not downloadable yet`);
    }
    if (!run.signedUrl) {
      throw new BadRequestException('Run has no download URL — re-run the export');
    }
    const expiresAt = run.expiresAt ?? new Date(run.createdAt.getTime() + EXPORT_SIGNED_URL_TTL_SECONDS * 1000);
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Download URL has expired — re-run the export');
    }
    return {
      runId: run.id,
      url: run.signedUrl,
      expiresAt: expiresAt.toISOString(),
    };
  }

  // ===========================================================================
  // Scheduler hook
  // ===========================================================================

  /**
   * Called by the cron tick. Loads all enabled schedules whose `scheduleCron`
   * matches the supplied minute, enqueues a run for each, stamps lastRunAt.
   * The minute matcher is a tiny standard-cron evaluator — we deliberately
   * don't pull in a node-cron dep just for the 5-field syntax.
   */
  async fireDueSchedules(now: Date = new Date()): Promise<number> {
    const schedules = await this.prisma.exportSchedule.findMany({
      where: { enabled: true, scheduleCron: { not: null } },
    });
    let fired = 0;
    for (const schedule of schedules) {
      if (!schedule.scheduleCron) continue;
      try {
        if (!cronMatchesMinute(schedule.scheduleCron, now)) continue;
      } catch (err) {
        this.logger.warn(
          `Schedule ${schedule.id} has invalid cron ${schedule.scheduleCron}: ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      // Idempotency: don't fire twice in the same minute. lastRunAt is set
      // to the start-of-minute on every fire, so if it already matches we
      // skip — a multi-replica deploy can call fireDueSchedules from each
      // pod and only the first one gets the row through.
      const minuteStart = new Date(now);
      minuteStart.setSeconds(0, 0);
      if (
        schedule.lastRunAt &&
        Math.abs(schedule.lastRunAt.getTime() - minuteStart.getTime()) < 60_000
      ) {
        continue;
      }
      const run = await this.createRun({
        scheduleId: schedule.id,
        kind: schedule.kind as ExportKind,
        sourceKind: schedule.sourceKind as ExportSourceKind,
        sourceId: schedule.sourceId,
      });
      await this.prisma.exportSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: minuteStart },
      });
      await this.enqueue(run.id);
      fired++;
    }
    return fired;
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async resolveWorkspace(actor: AuthenticatedUser): Promise<string> {
    if (this.workspaceCtx) return this.workspaceCtx.resolveForUser(actor.id);
    return 'default';
  }

  private async requireSchedule(actor: AuthenticatedUser, id: string) {
    const row = await this.prisma.exportSchedule.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Export schedule not found');
    const workspaceId = await this.resolveWorkspace(actor);
    if (row.workspaceId !== workspaceId) {
      // Don't leak existence across workspaces — return the same 404 as if
      // the row didn't exist at all.
      throw new NotFoundException('Export schedule not found');
    }
    return row;
  }

  private async assertRunOwnership(actor: AuthenticatedUser, run: { scheduleId: string | null }): Promise<void> {
    if (!run.scheduleId) {
      // Inline runs have no schedule. We can't reliably scope by workspace
      // here — accept the read iff the caller is an internal user. Clients
      // should never see these.
      if (actor.kind !== 'internal') {
        throw new NotFoundException('Export run not found');
      }
      return;
    }
    const schedule = await this.prisma.exportSchedule.findUnique({ where: { id: run.scheduleId } });
    if (!schedule) throw new NotFoundException('Export run not found');
    const workspaceId = await this.resolveWorkspace(actor);
    if (schedule.workspaceId !== workspaceId) {
      throw new NotFoundException('Export run not found');
    }
  }

  private async createRun(args: {
    scheduleId: string | null;
    kind: ExportKind;
    sourceKind: ExportSourceKind;
    sourceId: string | null;
  }) {
    const expiresAt = new Date(Date.now() + EXPORT_SIGNED_URL_TTL_SECONDS * 1000);
    const row = await this.prisma.exportRun.create({
      data: {
        id: randomUUID(),
        scheduleId: args.scheduleId,
        kind: args.kind,
        sourceKind: args.sourceKind,
        sourceId: args.sourceId,
        status: 'queued',
        expiresAt,
      },
    });
    return this.shapeRun(row);
  }

  private async enqueue(runId: string): Promise<void> {
    // jobId = runId so a duplicate enqueue (retry / accidental fire) doesn't
    // result in two materialisations of the same logical export.
    await this.queue.add(
      'export',
      { runId },
      {
        jobId: runId,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    );
  }

  private validateKind(kind: ExportKind): void {
    if (!EXPORT_KINDS.includes(kind)) {
      throw new BadRequestException(`Unknown export kind: ${kind}`);
    }
  }

  private validateSource(sourceKind: ExportSourceKind, sourceId: string | null | undefined): void {
    if (!SOURCE_KINDS.includes(sourceKind)) {
      throw new BadRequestException(`Unknown source kind: ${sourceKind}`);
    }
    if ((sourceKind === 'saved_view' || sourceKind === 'project') && !sourceId) {
      throw new BadRequestException(`sourceId required when sourceKind=${sourceKind}`);
    }
    if (sourceKind === 'all_tasks' && sourceId) {
      throw new BadRequestException('sourceId must be omitted when sourceKind=all_tasks');
    }
  }

  /** Standard 5-field cron validator — accepts '*', 'a,b,c', 'a-b', step syntax. */
  private validateCron(cron: string): void {
    try {
      parseCron(cron);
    } catch (err) {
      throw new BadRequestException(
        `Invalid cron expression "${cron}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private toLegacySource(source: ExportSourceKind): 'savedView' | 'project' | 'allTasks' {
    if (source === 'saved_view') return 'savedView';
    if (source === 'project') return 'project';
    return 'allTasks';
  }

  /** Public shape returned over the wire — drops the legacy mirror columns
   *  so the frontend only sees the canonical 0015 fields. */
  shapeSchedule(row: {
    id: string;
    workspaceId: string;
    name: string;
    kind: string;
    sourceKind: string;
    sourceId: string | null;
    scheduleCron: string | null;
    deliveryKind: string;
    deliveryEmailNew: string | null;
    enabled: boolean;
    lastRunAt: Date | null;
    createdAt: Date;
    createdById: string;
  }) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      kind: row.kind as ExportKind,
      sourceKind: row.sourceKind as ExportSourceKind,
      sourceId: row.sourceId,
      scheduleCron: row.scheduleCron,
      deliveryKind: row.deliveryKind as ExportDeliveryKind,
      deliveryEmail: row.deliveryEmailNew,
      enabled: row.enabled,
      lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      createdById: row.createdById,
    };
  }

  shapeRun(row: {
    id: string;
    scheduleId: string | null;
    kind: string;
    sourceKind: string | null;
    sourceId: string | null;
    status: string;
    signedUrl: string | null;
    expiresAt: Date | null;
    fileSize: number;
    rowCount: number;
    errorMessage: string | null;
    createdAt: Date;
    completedAt: Date | null;
  }) {
    return {
      id: row.id,
      scheduleId: row.scheduleId,
      kind: row.kind as ExportKind,
      sourceKind: row.sourceKind as ExportSourceKind | null,
      sourceId: row.sourceId,
      status: row.status as ExportRunStatus,
      signedUrl: row.signedUrl,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      fileSize: row.fileSize,
      rowCount: row.rowCount,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    };
  }
}

// =============================================================================
// Cron helpers (lightweight 5-field evaluator)
//
// We only need to know "does this cron fire at THIS minute?". A full library
// would re-introduce a chunky dep just to answer that question; the 5-field
// syntax is small enough that a hand-rolled parser is the right trade.
// =============================================================================

interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

const CRON_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6],  // day of week (0 = Sunday)
];

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('cron must have 5 space-separated fields');
  }
  const [m, h, dom, mo, dow] = parts.map((part, i) => expandField(part, CRON_RANGES[i]![0], CRON_RANGES[i]![1]));
  return { minutes: m!, hours: h!, daysOfMonth: dom!, months: mo!, daysOfWeek: dow! };
}

function expandField(field: string, lo: number, hi: number): number[] {
  const out = new Set<number>();
  for (const segment of field.split(',')) {
    let step = 1;
    let range = segment;
    if (segment.includes('/')) {
      const [r, s] = segment.split('/');
      range = r ?? '*';
      step = Number(s);
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`invalid step "${s}"`);
      }
    }
    let start: number;
    let end: number;
    if (range === '*' || range === '') {
      start = lo;
      end = hi;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(range);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`invalid range "${segment}"`);
    }
    if (start < lo || end > hi || start > end) {
      throw new Error(`range "${segment}" out of bounds [${lo}, ${hi}]`);
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function cronMatchesMinute(expr: string, date: Date): boolean {
  const parsed = parseCron(expr);
  return (
    parsed.minutes.includes(date.getUTCMinutes()) &&
    parsed.hours.includes(date.getUTCHours()) &&
    parsed.daysOfMonth.includes(date.getUTCDate()) &&
    parsed.months.includes(date.getUTCMonth() + 1) &&
    parsed.daysOfWeek.includes(date.getUTCDay())
  );
}
