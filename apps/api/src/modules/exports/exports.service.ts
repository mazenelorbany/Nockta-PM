import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';
import type { PermissionsService } from '../permissions/permissions.service';

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
 *  Postgres rather than trusting the queue. `actorId` is stamped at enqueue
 *  time so the processor can re-resolve the actor's project access and
 *  filter rows accordingly. NULL means the actor was deleted after enqueue
 *  but before the job ran — the processor treats this as "Admin only" and
 *  refuses to materialise the export. */
export interface ExportJobPayload {
  runId: string;
  actorId: string | null;
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
    @InjectQueue(EXPORTS_QUEUE) private readonly queue: Queue<ExportJobPayload>,
    private readonly permissions: PermissionsService,
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
    // Source-access gate. A user can only schedule an export for a source
    // they currently have access to. Re-checked at fire time in
    // fireDueSchedules so a later access revocation auto-disables the
    // schedule.
    await this.assertSourceAccess(actor, input.sourceKind, input.sourceId ?? null);

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
    // Admin sees every schedule; everyone else only sees their own. Without
    // this filter, any internal user could enumerate other users' delivery
    // emails, configured queries, and last-run timestamps — see the audit
    // notes for `requireSchedule`.
    const where: Prisma.ExportScheduleWhereInput =
      actor.companyRole === 'Admin' ? {} : { createdById: actor.id };
    const rows = await this.prisma.exportSchedule.findMany({
      where,
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
      // requireSchedule already enforces (createdById === actor.id || Admin),
      // and the source-access gate ran at createSchedule. We re-assert here
      // because the actor's project access may have changed between create
      // and re-run.
      const schedule = await this.requireSchedule(actor, args.scheduleId);
      await this.assertSourceAccess(
        actor,
        schedule.sourceKind as ExportSourceKind,
        schedule.sourceId,
      );
      const run = await this.createRun({
        scheduleId: schedule.id,
        kind: schedule.kind as ExportKind,
        sourceKind: schedule.sourceKind as ExportSourceKind,
        sourceId: schedule.sourceId,
        createdById: actor.id,
      });
      await this.prisma.exportSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: new Date() },
      });
      await this.enqueue(run.id, actor.id);
      return run;
    }
    // args.scheduleId is falsy here, so the discriminated union narrows to
    // the inline branch — TS doesn't infer that without the explicit guard.
    const inline = args.inline;
    if (!inline) throw new BadRequestException('Either scheduleId or inline must be provided');
    this.validateKind(inline.kind);
    this.validateSource(inline.sourceKind, inline.sourceId);
    await this.assertSourceAccess(actor, inline.sourceKind, inline.sourceId ?? null);
    const run = await this.createRun({
      scheduleId: null,
      kind: inline.kind,
      sourceKind: inline.sourceKind,
      sourceId: inline.sourceId ?? null,
      createdById: actor.id,
    });
    await this.enqueue(run.id, actor.id);
    return run;
  }

  async listRecentRuns(actor: AuthenticatedUser, opts: { scheduleId?: string; take?: number } = {}) {
    const take = Math.min(200, Math.max(1, opts.take ?? 50));
    const isAdmin = actor.companyRole === 'Admin';
    if (opts.scheduleId) {
      // requireSchedule enforces ownership on the schedule; runs under it
      // are then visible to the same actor.
      await this.requireSchedule(actor, opts.scheduleId);
      const runs = await this.prisma.exportRun.findMany({
        where: { scheduleId: opts.scheduleId },
        orderBy: { createdAt: 'desc' },
        take,
      });
      return runs.map((r) => this.shapeRun(r));
    }
    // No scheduleId filter — return runs the actor owns (scheduled or
    // inline) plus runs from schedules they own. Admin sees everything.
    const where: Prisma.ExportRunWhereInput = isAdmin
      ? {}
      : {
          OR: [
            { createdById: actor.id },
            { schedule: { createdById: actor.id } },
          ],
        };
    const runs = await this.prisma.exportRun.findMany({
      where,
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
      // Re-validate the creator's source access before firing. If the
      // creator has lost access (project access revoked, saved view
      // deleted, user archived), disable the schedule rather than keep
      // dumping data they shouldn't see anymore. Skip-but-don't-disable
      // for transient errors (DB hiccups) so a momentary blip doesn't
      // wipe a user's schedules.
      const creator = await this.loadCreatorForSchedule(schedule.createdById);
      if (!creator) {
        // Creator gone — disable the schedule, log loudly. The run history
        // remains, but no new runs fire.
        await this.prisma.exportSchedule.update({
          where: { id: schedule.id },
          data: { enabled: false },
        });
        this.logger.warn(
          { scheduleId: schedule.id, createdById: schedule.createdById },
          'fireDueSchedules: disabled schedule whose creator no longer exists',
        );
        continue;
      }
      try {
        await this.assertSourceAccess(
          creator,
          schedule.sourceKind as ExportSourceKind,
          schedule.sourceId,
        );
      } catch (err) {
        if (err instanceof ForbiddenException || err instanceof NotFoundException) {
          await this.prisma.exportSchedule.update({
            where: { id: schedule.id },
            data: { enabled: false },
          });
          this.logger.warn(
            {
              scheduleId: schedule.id,
              creatorId: creator.id,
              sourceKind: schedule.sourceKind,
              sourceId: schedule.sourceId,
            },
            "fireDueSchedules: disabled schedule whose creator lost source access",
          );
          continue;
        }
        // Re-throw unexpected errors so the scheduler logs them and the
        // operator notices.
        throw err;
      }
      const run = await this.createRun({
        scheduleId: schedule.id,
        kind: schedule.kind as ExportKind,
        sourceKind: schedule.sourceKind as ExportSourceKind,
        sourceId: schedule.sourceId,
        createdById: creator.id,
      });
      await this.prisma.exportSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: minuteStart },
      });
      await this.enqueue(run.id, creator.id);
      fired++;
    }
    return fired;
  }

  /**
   * Resolve a schedule's creator into an AuthenticatedUser-shaped object for
   * permission checks. Returns null if the user was deleted/archived.
   */
  private async loadCreatorForSchedule(
    createdById: string,
  ): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: createdById },
      select: { id: true, email: true, kind: true, companyRole: true, archivedAt: true },
    });
    if (!user || user.archivedAt) return null;
    return {
      id: user.id,
      email: user.email,
      kind: user.kind,
      companyRole: user.companyRole,
    } as AuthenticatedUser;
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async requireSchedule(actor: AuthenticatedUser, id: string) {
    const row = await this.prisma.exportSchedule.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Export schedule not found');
    // Ownership gate. Admins can read/update any schedule; everyone else is
    // limited to their own rows. Returning NotFound (not Forbidden) when an
    // unauthorized actor names someone else's id prevents id enumeration.
    if (row.createdById !== actor.id && actor.companyRole !== 'Admin') {
      throw new NotFoundException('Export schedule not found');
    }
    return row;
  }

  private async assertRunOwnership(
    actor: AuthenticatedUser,
    run: { scheduleId: string | null; createdById: string | null },
  ): Promise<void> {
    const isAdmin = actor.companyRole === 'Admin';
    if (isAdmin) return;
    // Inline runs (no schedule) — ownership is the run's createdById. A
    // NULL createdById means the run pre-dates the ownership model (or its
    // creator was deleted); only Admin reads in that case.
    if (!run.scheduleId) {
      if (run.createdById === actor.id) return;
      throw new NotFoundException('Export run not found');
    }
    // Scheduled runs — ownership is the schedule's createdById. The run
    // may have its own createdById (set at the time it was triggered),
    // in which case the actor who triggered it can also read it.
    if (run.createdById === actor.id) return;
    const schedule = await this.prisma.exportSchedule.findUnique({
      where: { id: run.scheduleId },
    });
    if (!schedule || schedule.createdById !== actor.id) {
      throw new NotFoundException('Export run not found');
    }
  }

  private async createRun(args: {
    scheduleId: string | null;
    kind: ExportKind;
    sourceKind: ExportSourceKind;
    sourceId: string | null;
    createdById: string | null;
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
        createdById: args.createdById,
      },
    });
    return this.shapeRun(row);
  }

  private async enqueue(runId: string, actorId: string | null): Promise<void> {
    // jobId = runId so a duplicate enqueue (retry / accidental fire) doesn't
    // result in two materialisations of the same logical export.
    await this.queue.add(
      'export',
      { runId, actorId },
      {
        jobId: runId,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    );
  }

  /**
   * Source-access gate, shared by createSchedule / runOnce inline / runOnce
   * scheduled / fireDueSchedules. Throws ForbiddenException if the actor
   * cannot read the requested source.
   *
   * - `project`: actor needs at least Viewer on the project.
   * - `saved_view`: actor must own the SavedSearch row (or be Admin).
   *   SavedSearch is per-user; there's no project link on the model.
   * - `all_tasks`: no upfront check — the processor filters by the actor's
   *   accessibleProjectIds at materialisation time.
   */
  private async assertSourceAccess(
    actor: AuthenticatedUser,
    sourceKind: ExportSourceKind,
    sourceId: string | null,
  ): Promise<void> {
    if (sourceKind === 'project') {
      if (!sourceId) throw new BadRequestException('sourceId required for project source');
      await this.permissions.assertAtLeast(actor, sourceId, 'Viewer');
      return;
    }
    if (sourceKind === 'saved_view') {
      if (!sourceId) throw new BadRequestException('sourceId required for saved_view source');
      const view = await this.prisma.savedSearch.findUnique({ where: { id: sourceId } });
      if (!view) throw new NotFoundException('Saved view not found');
      if (view.userId !== actor.id && actor.companyRole !== 'Admin') {
        throw new ForbiddenException('You do not have access to this saved view');
      }
      return;
    }
    // all_tasks: no upfront check; filtered in the processor.
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
    // internal: not reached from an HTTP request — pure helper; validateCron() wraps for HTTP.
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
        // internal: not reached from an HTTP request — pure helper; validateCron() wraps for HTTP.
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
      // internal: not reached from an HTTP request — pure helper; validateCron() wraps for HTTP.
      throw new Error(`invalid range "${segment}"`);
    }
    if (start < lo || end > hi || start > end) {
      // internal: not reached from an HTTP request — pure helper; validateCron() wraps for HTTP.
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
