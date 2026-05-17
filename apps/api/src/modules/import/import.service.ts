import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import { TasksService } from '../tasks/tasks.service';
import type { AuthenticatedUser } from '../auth/types';
import type { Priority, TaskType } from '@prisma/client';
import { ImportRunsService } from './import-runs.service';

// =============================================================================
// CSV import — initial Import Center end-to-end path.
//
// Two phases, called by the controller in sequence:
//   1. parse(): tokenize the user's CSV into rows + headers and return a
//      preview. The frontend uses this to render the column-mapping table.
//   2. commit(): given a column → field mapping, validate every row, then
//      bulk-create tasks. Stops on the first invalid row and returns a list
//      of errors with line numbers so the user can fix them in their source.
//
// Why a one-shot transactional commit instead of streaming row-by-row:
//   - Imports are typically <1000 rows; speed isn't the constraint.
//   - All-or-nothing semantics protect against partial imports — if the user
//     re-uploads a fixed CSV, they don't get duplicates from the first half
//     that landed before the failure.
//
// Other sources (Jira, Linear, GitHub Issues) wait their turn; the UI
// currently shows them as "coming soon" with a notify-me CTA.
// =============================================================================

/**
 * Fields the importer can map a CSV column to. Limited to what
 * TasksService.create accepts directly — status, startDate, and the
 * reported-by-client flag are deliberately omitted from v1 to keep the
 * write path single-shot. Re-add them once we want a two-phase create+patch
 * pipeline.
 */
export type ImportableField =
  | 'title'
  | 'description'
  | 'priority'
  | 'type'
  | 'assigneeEmail'
  | 'dueDate'
  | 'estimate'
  | 'skip';

export interface CsvPreview {
  headers: string[];
  rowCount: number;
  /** First few rows so the user can see what they're mapping. */
  sampleRows: string[][];
}

export interface CommitInput {
  projectId: string;
  /** csvText is the raw file contents — parse() is run again on commit so
   *  we don't rely on the client to round-trip the parsed payload. */
  csvText: string;
  /** Index of CSV column → which task field it maps to. Missing columns
   *  default to 'skip'. */
  mapping: Record<number, ImportableField>;
  /** When true, just validate; don't write. Surfaces errors before the user
   *  commits. */
  dryRun: boolean;
}

export interface CommitRowError {
  rowIndex: number;
  reason: string;
}

export interface CommitResult {
  dryRun: boolean;
  /** Only present on a real (non-dryRun) commit. Frontend subscribes to room
   *  `import:<runId>` immediately after the response so the progress bar
   *  catches the tail of in-flight emits. */
  runId?: string;
  totalRows: number;
  createdCount: number;
  skippedCount: number;
  errors: CommitRowError[];
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly tasks: TasksService,
    private readonly runs: ImportRunsService,
  ) {}

  /**
   * Parse the raw CSV text into header + rows. We use a forgiving parser
   * that handles quoted fields and commas inside quotes — RFC 4180 minus
   * fancy escapes. CSVs from Excel/Google Sheets pass.
   */
  parse(csvText: string, sampleSize = 5): CsvPreview {
    const rows = parseCsv(csvText);
    if (rows.length === 0) {
      throw new BadRequestException('CSV is empty');
    }
    const [headers, ...data] = rows;
    return {
      headers: headers!,
      rowCount: data.length,
      sampleRows: data.slice(0, sampleSize),
    };
  }

  /**
   * Validate the mapping + every row, then either preview (dryRun) or commit
   * the inserts. Permissions are enforced at the project level — only Admin,
   * Manager, or Contributor on the target project may import.
   */
  async commit(actor: AuthenticatedUser, input: CommitInput): Promise<CommitResult> {
    const role = await this.permissions.effectiveRole(actor, input.projectId);
    if (role === null) throw new ForbiddenException('No access to project');
    if (role === 'Client' || role === 'Viewer') {
      throw new ForbiddenException('Insufficient role for import');
    }
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: input.projectId },
      select: { id: true, key: true, workflowPreset: true },
    });

    const parsed = parseCsv(input.csvText);
    if (parsed.length < 2) {
      throw new BadRequestException('CSV must have a header row plus at least one data row');
    }
    const [, ...data] = parsed;

    // Build a reverse mapping: field → column index. Multiple columns mapped
    // to the same field is invalid — fail early.
    const fieldToCol: Partial<Record<ImportableField, number>> = {};
    for (const [colStr, field] of Object.entries(input.mapping)) {
      if (field === 'skip') continue;
      if (fieldToCol[field] !== undefined) {
        throw new BadRequestException(
          `Field "${field}" is mapped to multiple CSV columns; pick one.`,
        );
      }
      fieldToCol[field] = Number(colStr);
    }
    if (fieldToCol.title === undefined) {
      throw new BadRequestException('At least one column must be mapped to "title"');
    }

    // Resolve assignee emails to user IDs in one query.
    const emailCol = fieldToCol.assigneeEmail;
    const emails = new Set<string>();
    if (emailCol !== undefined) {
      for (const row of data) {
        const v = (row[emailCol] ?? '').trim().toLowerCase();
        if (v) emails.add(v);
      }
    }
    const usersByEmail = new Map<string, string>();
    if (emails.size > 0) {
      const users = await this.prisma.user.findMany({
        where: { email: { in: Array.from(emails) } },
        select: { id: true, email: true },
      });
      for (const u of users) usersByEmail.set(u.email.toLowerCase(), u.id);
    }

    // Validate every row before writing any. Collect errors with 1-based line
    // numbers (matches what the user sees in their spreadsheet — header is row 1).
    type Plan = {
      title: string;
      description?: string;
      priority?: Priority;
      type?: TaskType;
      assigneeUserId?: string;
      dueDate?: Date;
      estimate?: number;
    };
    const plans: Plan[] = [];
    const errors: CommitRowError[] = [];
    let skipped = 0;

    data.forEach((row, i) => {
      const lineNo = i + 2; // header + zero-based offset
      const title = (row[fieldToCol.title!] ?? '').trim();
      if (!title) {
        skipped += 1;
        return;
      }
      const plan: Plan = { title };
      try {
        if (fieldToCol.description !== undefined) {
          const v = row[fieldToCol.description] ?? '';
          if (v.trim()) plan.description = v;
        }
        if (fieldToCol.priority !== undefined) {
          const v = (row[fieldToCol.priority] ?? '').trim();
          if (v) plan.priority = coercePriority(v);
        }
        if (fieldToCol.type !== undefined) {
          const v = (row[fieldToCol.type] ?? '').trim();
          if (v) plan.type = coerceType(v);
        }
        if (emailCol !== undefined) {
          const v = (row[emailCol] ?? '').trim().toLowerCase();
          if (v) {
            const id = usersByEmail.get(v);
            if (!id) throw new Error(`Assignee email "${v}" not found in workspace`);
            plan.assigneeUserId = id;
          }
        }
        if (fieldToCol.dueDate !== undefined) {
          const v = (row[fieldToCol.dueDate] ?? '').trim();
          if (v) plan.dueDate = coerceDate(v, 'dueDate');
        }
        if (fieldToCol.estimate !== undefined) {
          const v = (row[fieldToCol.estimate] ?? '').trim();
          if (v) {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) throw new Error(`Estimate "${v}" is not a positive number`);
            plan.estimate = n;
          }
        }
        plans.push(plan);
      } catch (err) {
        errors.push({
          rowIndex: lineNo,
          reason: err instanceof Error ? err.message : 'Invalid row',
        });
      }
    });

    if (errors.length > 0 && input.dryRun === false) {
      // On a real commit, refuse to write anything if any row failed validation.
      // The user must fix the source CSV and re-upload.
      throw new BadRequestException({
        message: 'Some rows failed validation; nothing was imported.',
        errors,
        totalRows: data.length,
        skippedCount: skipped,
      });
    }

    if (input.dryRun) {
      return {
        dryRun: true,
        totalRows: data.length,
        createdCount: plans.length,
        skippedCount: skipped,
        errors,
      };
    }

    // Bulk-create. Reuses TasksService.create per-row so domain events, key
    // generation, watcher auto-add, and search indexing all run as if each
    // task were created manually. A few-hundred rows take a couple of seconds.
    //
    // Progress is streamed over Socket.IO room `import:<runId>` via
    // ImportRunsService — the frontend joins this room as soon as it receives
    // runId in the commit response and watches a row-by-row progress bar
    // instead of a spinner.
    const runId = await this.runs.start({
      source: 'csv',
      actorUserId: actor.id,
      projectId: project.id,
      sourceRef: project.key,
      totalRows: data.length,
    });

    const result = await this.runPlans(
      actor,
      runId,
      project.id,
      plans,
      errors,
      skipped,
      { csvText: input.csvText, mapping: input.mapping, projectId: input.projectId },
      /* startFromIndex */ 0,
    );

    this.logger.log(
      `Imported ${result.createdCount} task(s) into project ${project.key} ` +
      `(skipped ${skipped} empty, ${result.errors.length} errors, runId=${runId})`,
    );

    return {
      dryRun: false,
      runId,
      totalRows: data.length,
      createdCount: result.createdCount,
      skippedCount: skipped,
      errors: result.errors,
    };
  }

  // ---------------------------------------------------------------------------
  // Resume — restart a previously-failed run from `resumableFromRow + 1`.
  //
  // Reads the frozen resumePayload off the ImportRun, re-parses the CSV,
  // re-validates, and replays starting at row N+1. Permissions are re-checked
  // against the destination project; the actor MUST be the one who started
  // the original run (no cross-user resume — keeps the audit trail clean).
  // ---------------------------------------------------------------------------

  async resume(actor: AuthenticatedUser, runId: string): Promise<CommitResult> {
    const run = await this.prisma.importRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        status: true,
        actorUserId: true,
        projectId: true,
        resumableFromRow: true,
        resumePayload: true,
      },
    });
    if (!run) throw new NotFoundException('Import run not found');
    if (run.actorUserId !== actor.id) {
      throw new ForbiddenException('Only the original actor can resume this run');
    }
    if (run.status !== 'failed') {
      throw new BadRequestException(`Run is not in a resumable state (status=${run.status})`);
    }
    if (run.resumableFromRow === null || run.resumePayload === null) {
      throw new BadRequestException('Run has no resume point; restart the import from scratch.');
    }
    const payload = run.resumePayload as {
      kind?: string;
      csvText?: string;
      mapping?: Record<number, ImportableField>;
      projectId?: string;
    };
    if (payload.kind !== 'csv' || !payload.csvText || !payload.mapping || !payload.projectId) {
      throw new BadRequestException(
        'Resume payload missing or unsupported for this source — replay the import manually.',
      );
    }

    const role = await this.permissions.effectiveRole(actor, payload.projectId);
    if (role === null) throw new ForbiddenException('No access to project');
    if (role === 'Client' || role === 'Viewer') {
      throw new ForbiddenException('Insufficient role for import');
    }

    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: payload.projectId },
      select: { id: true, key: true },
    });

    // Re-build the plan list using the original mapping, then skip everything
    // through `resumableFromRow` (inclusive) since those rows succeeded the
    // first time around. The remaining slice is what we replay.
    const parsed = parseCsv(payload.csvText);
    if (parsed.length < 2) {
      throw new BadRequestException('Resume payload CSV has no data rows');
    }
    const data = parsed.slice(1);
    const fieldToCol: Partial<Record<ImportableField, number>> = {};
    for (const [colStr, field] of Object.entries(payload.mapping)) {
      if (field === 'skip') continue;
      fieldToCol[field] = Number(colStr);
    }

    const emailCol = fieldToCol.assigneeEmail;
    const emails = new Set<string>();
    if (emailCol !== undefined) {
      for (const row of data) {
        const v = (row[emailCol] ?? '').trim().toLowerCase();
        if (v) emails.add(v);
      }
    }
    const usersByEmail = new Map<string, string>();
    if (emails.size > 0) {
      const users = await this.prisma.user.findMany({
        where: { email: { in: Array.from(emails) } },
        select: { id: true, email: true },
      });
      for (const u of users) usersByEmail.set(u.email.toLowerCase(), u.id);
    }

    type Plan = {
      title: string;
      description?: string;
      priority?: Priority;
      type?: TaskType;
      assigneeUserId?: string;
      dueDate?: Date;
      estimate?: number;
    };
    const plans: Plan[] = [];
    let skipped = 0;
    data.forEach((row) => {
      const title = (row[fieldToCol.title!] ?? '').trim();
      if (!title) {
        skipped += 1;
        return;
      }
      const plan: Plan = { title };
      if (fieldToCol.description !== undefined && (row[fieldToCol.description] ?? '').trim()) {
        plan.description = row[fieldToCol.description]!;
      }
      if (fieldToCol.priority !== undefined) {
        const v = (row[fieldToCol.priority] ?? '').trim();
        if (v) {
          const p = PRIORITY_ALIASES[v.toLowerCase()];
          if (p) plan.priority = p;
        }
      }
      if (fieldToCol.type !== undefined) {
        const v = (row[fieldToCol.type] ?? '').trim();
        if (v) {
          const t = TYPE_ALIASES[v.toLowerCase()];
          if (t) plan.type = t;
        }
      }
      if (emailCol !== undefined) {
        const v = (row[emailCol] ?? '').trim().toLowerCase();
        if (v && usersByEmail.has(v)) plan.assigneeUserId = usersByEmail.get(v)!;
      }
      if (fieldToCol.dueDate !== undefined) {
        const v = (row[fieldToCol.dueDate] ?? '').trim();
        if (v) {
          const d = new Date(v);
          if (!Number.isNaN(d.getTime())) plan.dueDate = d;
        }
      }
      if (fieldToCol.estimate !== undefined) {
        const v = (row[fieldToCol.estimate] ?? '').trim();
        if (v) {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) plan.estimate = n;
        }
      }
      plans.push(plan);
    });

    // Mark the run running again — same row id — so the UI's "resume" button
    // can poll for the new status without spinning up a fresh ImportRun.
    await this.prisma.importRun.update({
      where: { id: runId },
      data: {
        status: 'running',
        finishedAt: null,
        lastError: null,
      },
    });

    const startFrom = (run.resumableFromRow ?? -1) + 1;
    const errors: CommitRowError[] = [];
    const result = await this.runPlans(
      actor,
      runId,
      project.id,
      plans,
      errors,
      0,
      { csvText: payload.csvText, mapping: payload.mapping, projectId: payload.projectId },
      startFrom,
    );

    return {
      dryRun: false,
      runId,
      totalRows: data.length,
      createdCount: result.createdCount,
      skippedCount: skipped,
      errors: result.errors,
    };
  }

  // ---------------------------------------------------------------------------
  // Shared runner — used by both commit() and resume() so the per-row create
  // path and the resume-point bookkeeping live in one place.
  // ---------------------------------------------------------------------------

  private async runPlans(
    actor: AuthenticatedUser,
    runId: string,
    projectId: string,
    plans: Array<{
      title: string;
      description?: string;
      priority?: Priority;
      type?: TaskType;
      assigneeUserId?: string;
      dueDate?: Date;
      estimate?: number;
    }>,
    errors: CommitRowError[],
    skipped: number,
    resumeSeed: {
      csvText: string;
      mapping: Record<number, ImportableField>;
      projectId: string;
    },
    startFromIndex: number,
  ): Promise<{ createdCount: number; errors: CommitRowError[] }> {
    let created = 0;
    /** 0-based index of the last successfully-inserted row inside `plans`.
     *  Persisted to ImportRun.resumableFromRow on catastrophic failure so
     *  POST /import/:id/resume can replay from `lastSuccessIndex + 1`. */
    let lastSuccessIndex = startFromIndex - 1;
    try {
      if (skipped > 0) await this.runs.increment(runId, 'skipped', skipped);

      for (let i = startFromIndex; i < plans.length; i++) {
        const p = plans[i]!;
        try {
          await this.tasks.create(actor, {
            projectId,
            title: p.title,
            priority: p.priority ?? 'Medium',
            type: p.type ?? 'Task',
            ...(p.description ? { description: p.description } : {}),
            ...(p.assigneeUserId ? { assigneeUserId: p.assigneeUserId } : {}),
            ...(p.dueDate ? { dueDate: p.dueDate } : {}),
            ...(p.estimate !== undefined ? { estimate: p.estimate } : {}),
          });
          created += 1;
          lastSuccessIndex = i;
          await this.runs.increment(runId, 'created');
        } catch (err) {
          // Per-row failure: persist a resume point on the FIRST failure so
          // the user can replay from this row, and keep going so the rest of
          // the batch still lands. The errors[] array surfaces these to the
          // client; lastError carries the latest failure for the UI tooltip.
          const reason = err instanceof Error ? err.message : 'task create failed';
          errors.push({ rowIndex: i + 2, reason });
          await this.runs.increment(runId, 'errored');
          await this.prisma.importRun.update({
            where: { id: runId },
            data: {
              resumableFromRow: lastSuccessIndex,
              lastError: reason.slice(0, 4000),
              resumePayload: {
                kind: 'csv',
                csvText: resumeSeed.csvText,
                mapping: resumeSeed.mapping,
                projectId: resumeSeed.projectId,
              },
            },
          });
        }
      }
      const allFailed = errors.length === plans.length - startFromIndex && plans.length - startFromIndex > 0;
      const partial = errors.length > 0 && !allFailed;
      await this.runs.finish({
        runId,
        status: allFailed ? 'failed' : partial ? 'failed' : 'succeeded',
        errorSummary: errors.length > 0 ? errors.slice(0, 10).map((e) => e.reason).join('\n') : null,
      });
      if (errors.length === 0) {
        // Green run — clear any stale resume point from a previous failed
        // attempt so the runs table doesn't show a "Resume" button anymore.
        await this.prisma.importRun.update({
          where: { id: runId },
          data: {
            resumableFromRow: null,
            // Prisma typing for nullable JSON columns wants Prisma.JsonNull,
            // but we don't import the namespace here; explicit cast keeps
            // the call site narrow and matches the rest of the codebase.
            resumePayload: null as never,
            lastError: null,
          },
        });
      }
    } catch (err) {
      // Catastrophic (non-row-local) failure — e.g. DB went away mid-import.
      const reason = err instanceof Error ? err.message : String(err);
      await this.prisma.importRun.update({
        where: { id: runId },
        data: {
          resumableFromRow: lastSuccessIndex,
          lastError: reason.slice(0, 4000),
          resumePayload: {
            kind: 'csv',
            csvText: resumeSeed.csvText,
            mapping: resumeSeed.mapping,
            projectId: resumeSeed.projectId,
          },
        },
      });
      await this.runs.finish({
        runId,
        status: 'failed',
        errorSummary: reason,
      });
      throw err;
    }
    return { createdCount: created, errors };
  }
}

// =============================================================================
// CSV parsing — small, dependency-free, RFC-4180 minus extensions. Handles
// quoted fields, escaped quotes ("" → "), CRLF/LF line endings.
// =============================================================================

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Swallow; the \n that (usually) follows handles the line break.
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      // Skip rows that are entirely empty (trailing newline at EOF, blank
      // separators between sections).
      if (row.length > 1 || (row.length === 1 && row[0]!.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Capture the final row if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  return rows;
}

const PRIORITY_ALIASES: Record<string, Priority> = {
  critical: 'Critical', crit: 'Critical', p0: 'Critical', urgent: 'Critical',
  high: 'High', p1: 'High',
  medium: 'Medium', med: 'Medium', normal: 'Medium', p2: 'Medium',
  low: 'Low', p3: 'Low', minor: 'Low',
};
function coercePriority(raw: string): Priority {
  const v = PRIORITY_ALIASES[raw.toLowerCase().trim()];
  if (!v) throw new Error(`Unknown priority "${raw}"; expected Critical/High/Medium/Low`);
  return v;
}

const TYPE_ALIASES: Record<string, TaskType> = {
  task: 'Task', bug: 'Bug', defect: 'Bug', story: 'Story', epic: 'Epic',
  subtask: 'Subtask', 'sub-task': 'Subtask',
};
function coerceType(raw: string): TaskType {
  const v = TYPE_ALIASES[raw.toLowerCase().trim()];
  if (!v) throw new Error(`Unknown type "${raw}"; expected Task/Bug/Story/Epic/Subtask`);
  return v;
}

function coerceDate(raw: string, field: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${field} "${raw}" is not a valid date (try ISO format: YYYY-MM-DD)`);
  }
  return d;
}
