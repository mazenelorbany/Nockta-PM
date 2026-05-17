import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Priority, TaskType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionsService } from '../../permissions/permissions.service';
import { TasksService } from '../../tasks/tasks.service';
import type { AuthenticatedUser } from '../../auth/types';
import { ImportRunsService } from '../import-runs.service';
import type {
  DryRunResult,
  DryRunRowError,
  DryRunPreviewRow,
  ImportSourceFieldDescriptor,
} from '../adapter.types';

// =============================================================================
// jira-csv.importer.ts (Pass D — new adapter)
//
// Reads Jira's "Export Issues" CSV (Issues → … → Export → CSV (all fields))
// without requiring API credentials. The format is stable enough that we can
// hard-code descriptors and let the mapper UI render them like any other
// adapter.
//
// Workflow-status mapping is the interesting bit: each Nockta project carries
// a `workflowPreset` (engineering/design/generic), and each preset has its
// own canonical status set. We ship a small preset table here so the user
// doesn't have to override every row — they can if they want via the mapper
// UI, but the defaults are sensible for the common Jira presets.
//
// Tests live in `imports.service.test.ts` (see "Jira CSV adapter" block);
// golden fixture is `jira-csv/fixtures/sample-export.csv`.
// =============================================================================

/** Source columns Jira's standard CSV export emits. Order is not load-bearing
 *  — we look the column up by name, not index. Multi-value fields (e.g.
 *  Labels) come back as separate columns with the same header; the parser
 *  collapses them into a single array under the canonical key. */
export const JIRA_CSV_SOURCE_FIELDS: readonly ImportSourceFieldDescriptor[] = [
  {
    key: 'Issue key',
    label: 'Issue key',
    description: 'Jira identifier (e.g. PROJ-123). Read-only; preserved as sourceRef.',
    sample: 'PROJ-123',
  },
  {
    key: 'Summary',
    label: 'Summary',
    description: 'Maps to Nockta task title.',
    sample: 'Investigate flaky login flow',
    suggestedFieldKey: 'title',
  },
  {
    key: 'Description',
    label: 'Description',
    sample: 'Steps to reproduce: …',
    suggestedFieldKey: 'description',
  },
  {
    key: 'Status',
    label: 'Status',
    description: 'Mapped via the workflow preset table; user can override.',
    sample: 'In Progress',
    suggestedFieldKey: 'status',
  },
  {
    key: 'Priority',
    label: 'Priority',
    sample: 'High',
    suggestedFieldKey: 'priority',
  },
  {
    key: 'Issue Type',
    label: 'Issue Type',
    sample: 'Bug',
    suggestedFieldKey: 'type',
  },
  {
    key: 'Assignee',
    label: 'Assignee (display name)',
    sample: 'Jane Doe',
  },
  {
    key: 'Assignee Email',
    label: 'Assignee email',
    sample: 'jane@acme.com',
    suggestedFieldKey: 'assigneeEmail',
  },
  {
    key: 'Reporter',
    label: 'Reporter',
    sample: 'John Smith',
  },
  {
    key: 'Created',
    label: 'Created',
    description: 'Read-only; carried over as task createdAt.',
    sample: '2024-09-01T12:34:56.000+0000',
  },
  {
    key: 'Updated',
    label: 'Updated',
    sample: '2024-09-15T08:22:11.000+0000',
  },
  {
    key: 'Due date',
    label: 'Due date',
    sample: '2024-10-01',
    suggestedFieldKey: 'dueDate',
  },
  {
    key: 'Labels',
    label: 'Labels (may repeat)',
    sample: 'backend, infra',
    suggestedFieldKey: 'labels',
  },
] as const;

/** Type alias for downstream consumers — matches the descriptor type shape. */
export type JiraCsvSourceFieldDescriptor = ImportSourceFieldDescriptor;

/** Per-workflow-preset status-mapping presets. Keys are LOWERCASED Jira
 *  status names; values are the Nockta status to write. Anything not present
 *  falls back to mapStatusFallback() below. */
export const JIRA_STATUS_PRESETS: Record<
  'engineering' | 'design' | 'generic',
  Record<string, string>
> = {
  engineering: {
    'to do': 'Todo',
    'open': 'Todo',
    'backlog': 'Todo',
    'in progress': 'In Progress',
    'in development': 'In Progress',
    'in review': 'In Review',
    'code review': 'In Review',
    'qa': 'In Review',
    'testing': 'In Review',
    'done': 'Done',
    'closed': 'Done',
    'resolved': 'Done',
    'cancelled': 'Done',
  },
  design: {
    'to do': 'Todo',
    'open': 'Todo',
    'in progress': 'Designing',
    'in design': 'Designing',
    'in review': 'In Review',
    'approved': 'Done',
    'done': 'Done',
    'closed': 'Done',
  },
  generic: {
    'to do': 'Todo',
    'open': 'Todo',
    'in progress': 'In Progress',
    'doing': 'In Progress',
    'done': 'Done',
    'closed': 'Done',
  },
};

function mapStatusFallback(raw: string): string {
  const v = raw.toLowerCase().trim();
  if (['done', 'closed', 'resolved', 'cancelled'].includes(v)) return 'Done';
  if (['in progress', 'doing', 'active', 'in development'].includes(v)) return 'In Progress';
  if (['in review', 'code review', 'qa', 'testing'].includes(v)) return 'In Review';
  return 'Todo';
}

const PRIORITY_ALIASES: Record<string, Priority> = {
  highest: 'Critical',
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  normal: 'Medium',
  low: 'Low',
  lowest: 'Low',
};

const TYPE_ALIASES: Record<string, TaskType> = {
  bug: 'Bug',
  defect: 'Bug',
  story: 'Story',
  task: 'Task',
  'sub-task': 'Subtask',
  subtask: 'Subtask',
  epic: 'Epic',
};

/** Per-source mapping overrides the UI can send. Status / priority / type
 *  overrides are merged on top of the preset; anything in `columnMap`
 *  remaps a source column header → a Nockta field key (e.g. "Summary" → "title"). */
export interface JiraCsvMapping {
  preset?: 'engineering' | 'design' | 'generic';
  /** Lowercased Jira status → Nockta status. Merged on top of the preset's table. */
  statusOverrides?: Record<string, string>;
  /** Column header → Nockta field. Defaults to the descriptors' suggestions. */
  columnMap?: Record<string, string>;
}

export interface JiraCsvRunOptions {
  actorUserId: string;
  projectId: string;
  /** When true, parse + validate but don't persist (matches dryRun on the
   *  unified dryRun endpoint). */
  dryRun?: boolean;
}

interface ParsedRow {
  /** Original 1-based row number in the user's spreadsheet (header = 1). */
  rowIndex: number;
  fields: Record<string, string | string[]>;
}

@Injectable()
export class JiraCsvImporter {
  private readonly logger = new Logger(JiraCsvImporter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly tasks: TasksService,
    private readonly runs: ImportRunsService,
  ) {}

  /** Parse Jira's CSV into rows keyed by the column header. Multi-value
   *  columns (Labels, Components, Sprint) get collapsed into a single
   *  string[] under the canonical header. */
  parse(csvText: string): ParsedRow[] {
    const rows = parseCsv(csvText);
    if (rows.length === 0) throw new BadRequestException('CSV is empty');
    const [headers, ...data] = rows;
    if (!headers || headers.length === 0) {
      throw new BadRequestException('CSV has no header row');
    }

    // Map of header name → list of column indices that carry that header.
    // Jira repeats some columns (Labels, Comments, Sprint) so we collapse.
    const headerIdx = new Map<string, number[]>();
    headers.forEach((h, i) => {
      const list = headerIdx.get(h) ?? [];
      list.push(i);
      headerIdx.set(h, list);
    });

    return data.map((row, di) => {
      const fields: Record<string, string | string[]> = {};
      for (const [header, indices] of headerIdx.entries()) {
        if (indices.length === 1) {
          const v = (row[indices[0]!] ?? '').trim();
          if (v) fields[header] = v;
        } else {
          const vals = indices
            .map((i) => (row[i] ?? '').trim())
            .filter((v) => v.length > 0);
          if (vals.length > 0) fields[header] = vals;
        }
      }
      return { rowIndex: di + 2, fields };
    });
  }

  /** Dry-run preview: parse, validate, project the first N rows into the
   *  same shape the run path would insert. Does NOT persist. */
  async dryRun(
    actor: AuthenticatedUser,
    projectId: string,
    csvText: string,
    mapping: JiraCsvMapping,
    previewLimit = 10,
  ): Promise<DryRunResult> {
    const role = await this.permissions.effectiveRole(actor, projectId);
    if (role === null) throw new ForbiddenException('No access to project');
    if (role === 'Client' || role === 'Viewer') {
      throw new ForbiddenException('Insufficient role for import');
    }

    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { id: true, workspaceId: true, workflowPreset: true },
    });
    const preset = mapping.preset ?? project.workflowPreset;
    // Workspace-level JiraStatusMap rows go on top of the preset table but
    // lose to per-run statusOverrides. Order: preset → workspace → per-run.
    const wsOverrides = await this.prisma.jiraStatusMap.findMany({
      where: { workspaceId: project.workspaceId },
      select: { jiraStatus: true, nocktaStatus: true },
    });
    const statusTable: Record<string, string> = { ...JIRA_STATUS_PRESETS[preset] };
    for (const r of wsOverrides) statusTable[r.jiraStatus.toLowerCase()] = r.nocktaStatus;
    for (const [k, v] of Object.entries(mapping.statusOverrides ?? {})) {
      statusTable[k.toLowerCase()] = v;
    }

    const parsed = this.parse(csvText);
    const errors: DryRunRowError[] = [];
    const preview: DryRunPreviewRow[] = [];
    let wouldInsert = 0;
    let wouldSkip = 0;

    parsed.forEach((row, idx) => {
      const result = this.validateRow(row, statusTable, mapping.columnMap ?? {});
      if (idx < previewLimit) preview.push(result.previewRow);
      errors.push(...result.errors);
      if (result.errors.length > 0) {
        // Errored rows still don't insert.
      } else if (result.skipped) {
        wouldSkip += 1;
      } else {
        wouldInsert += 1;
      }
    });

    return {
      preview,
      errors,
      wouldInsert,
      wouldSkip,
      totalRows: parsed.length,
    };
  }

  /** Validate + project a single row. Pure (no DB calls) so dryRun and the
   *  real run can share the same logic. */
  private validateRow(
    row: ParsedRow,
    statusTable: Record<string, string>,
    columnMap: Record<string, string>,
  ): { previewRow: DryRunPreviewRow; errors: DryRunRowError[]; skipped: boolean } {
    const errors: DryRunRowError[] = [];
    const fields: Record<string, string | number | null> = {};
    const errorsByField: Record<string, string> = {};

    /** Look up a source column, applying any user-supplied remap. The
     *  mapper UI lets users express the remap two ways:
     *    - by canonical source header: `{ "Title": "Summary" }` ("CSV's
     *      Title column is Summary"),
     *    - by Nockta target field key:  `{ "Title": "title"   }` ("CSV's
     *      Title column is the title field").
     *  Both are valid and used in practice. We honor either by reverse-
     *  matching against the canonical column AND its suggestedFieldKey. */
    const sourceFor = (canonical: string): string | string[] | undefined => {
      const targetFieldKey = JIRA_CSV_SOURCE_FIELDS.find((f) => f.key === canonical)
        ?.suggestedFieldKey;
      const remappedKey = Object.entries(columnMap).find(
        ([, v]) => v === canonical || (targetFieldKey != null && v === targetFieldKey),
      )?.[0];
      const key = remappedKey ?? canonical;
      return row.fields[key];
    };

    // ---- title (required) --------------------------------------------------
    const title = String(sourceFor('Summary') ?? '').trim();
    if (!title) {
      // Empty Summary = silently skip, matching CSV importer semantics.
      fields.title = null;
      return {
        previewRow: { rowIndex: row.rowIndex, fields, errorsByField },
        errors,
        skipped: true,
      };
    }
    fields.title = title;

    // ---- description -------------------------------------------------------
    const desc = sourceFor('Description');
    if (desc !== undefined) fields.description = String(desc);

    // ---- priority ----------------------------------------------------------
    const prioRaw = String(sourceFor('Priority') ?? '').trim();
    if (prioRaw) {
      const prio = PRIORITY_ALIASES[prioRaw.toLowerCase()];
      if (!prio) {
        const msg = `Unknown priority "${prioRaw}"; expected Highest/High/Medium/Low/Lowest`;
        errors.push({ row: row.rowIndex, field: 'priority', message: msg });
        errorsByField.priority = msg;
      } else {
        fields.priority = prio;
      }
    }

    // ---- type --------------------------------------------------------------
    const typeRaw = String(sourceFor('Issue Type') ?? '').trim();
    if (typeRaw) {
      const t = TYPE_ALIASES[typeRaw.toLowerCase()];
      if (!t) {
        const msg = `Unknown type "${typeRaw}"; expected Task/Bug/Story/Epic/Subtask`;
        errors.push({ row: row.rowIndex, field: 'type', message: msg });
        errorsByField.type = msg;
      } else {
        fields.type = t;
      }
    }

    // ---- status ------------------------------------------------------------
    const statusRaw = String(sourceFor('Status') ?? '').trim();
    if (statusRaw) {
      const mapped = statusTable[statusRaw.toLowerCase()] ?? mapStatusFallback(statusRaw);
      fields.status = mapped;
    }

    // ---- assigneeEmail -----------------------------------------------------
    const emailRaw = String(sourceFor('Assignee Email') ?? '').trim();
    if (emailRaw) {
      if (!emailRaw.includes('@')) {
        const msg = `Assignee email "${emailRaw}" is not a valid email address`;
        errors.push({ row: row.rowIndex, field: 'assigneeEmail', message: msg });
        errorsByField.assigneeEmail = msg;
      } else {
        fields.assigneeEmail = emailRaw.toLowerCase();
      }
    }

    // ---- dueDate -----------------------------------------------------------
    const dueRaw = String(sourceFor('Due date') ?? '').trim();
    if (dueRaw) {
      const d = new Date(dueRaw);
      if (Number.isNaN(d.getTime())) {
        const msg = `Due date "${dueRaw}" is not a valid date (try ISO format: YYYY-MM-DD)`;
        errors.push({ row: row.rowIndex, field: 'dueDate', message: msg });
        errorsByField.dueDate = msg;
      } else {
        fields.dueDate = d.toISOString().slice(0, 10);
      }
    }

    // ---- labels ------------------------------------------------------------
    const labels = sourceFor('Labels');
    if (labels !== undefined) {
      const labelList = Array.isArray(labels) ? labels : [labels];
      fields.labels = labelList.join(', ');
    }

    return {
      previewRow: { rowIndex: row.rowIndex, fields, errorsByField },
      errors,
      skipped: false,
    };
  }

  /** Real run — same validation as dryRun, then insert. Streams progress via
   *  ImportRunsService so the existing socket UI works unmodified. */
  async runImport(
    actor: AuthenticatedUser,
    csvText: string,
    mapping: JiraCsvMapping,
    options: JiraCsvRunOptions,
  ): Promise<{ runId: string }> {
    const role = await this.permissions.effectiveRole(actor, options.projectId);
    if (role === null) throw new ForbiddenException('No access to project');
    if (role === 'Client' || role === 'Viewer') {
      throw new ForbiddenException('Insufficient role for import');
    }

    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: options.projectId },
      select: { id: true, key: true, workspaceId: true, workflowPreset: true },
    });
    const preset = mapping.preset ?? project.workflowPreset;
    const wsOverrides = await this.prisma.jiraStatusMap.findMany({
      where: { workspaceId: project.workspaceId },
      select: { jiraStatus: true, nocktaStatus: true },
    });
    const statusTable: Record<string, string> = { ...JIRA_STATUS_PRESETS[preset] };
    for (const r of wsOverrides) statusTable[r.jiraStatus.toLowerCase()] = r.nocktaStatus;
    for (const [k, v] of Object.entries(mapping.statusOverrides ?? {})) {
      statusTable[k.toLowerCase()] = v;
    }

    const parsed = this.parse(csvText);
    const errors: { rowIndex: number; reason: string }[] = [];
    const plans: Array<{ rowIndex: number; fields: Record<string, string | number | null> }> = [];
    let skipped = 0;

    for (const row of parsed) {
      const r = this.validateRow(row, statusTable, mapping.columnMap ?? {});
      if (r.errors.length > 0) {
        errors.push({ rowIndex: row.rowIndex, reason: r.errors.map((e) => e.message).join('; ') });
        continue;
      }
      if (r.skipped) {
        skipped += 1;
        continue;
      }
      plans.push({ rowIndex: row.rowIndex, fields: r.previewRow.fields });
    }

    const runId = await this.runs.start({
      source: 'csv', // share the csv ImportRun source for table compatibility
      actorUserId: actor.id,
      projectId: project.id,
      sourceRef: `jira-csv:${project.key}`,
      totalRows: parsed.length,
      mappingSnapshot: { kind: 'jira-csv', mapping, projectId: project.id },
    });

    if (options.dryRun) {
      if (parsed.length > 0) await this.runs.increment(runId, 'skipped', parsed.length);
      await this.runs.finish({ runId, status: 'succeeded' });
      return { runId };
    }

    // Resolve assignee emails to user ids in one batch.
    const emails = Array.from(
      new Set(plans.map((p) => p.fields.assigneeEmail).filter((v): v is string => typeof v === 'string')),
    );
    const usersByEmail = new Map<string, string>();
    if (emails.length > 0) {
      const users = await this.prisma.user.findMany({
        where: { email: { in: emails } },
        select: { id: true, email: true },
      });
      for (const u of users) usersByEmail.set(u.email.toLowerCase(), u.id);
    }

    if (skipped > 0) await this.runs.increment(runId, 'skipped', skipped);

    let processed = 0;
    let lastSuccessfulIdx = -1;
    try {
      for (const plan of plans) {
        try {
          const assigneeEmail = typeof plan.fields.assigneeEmail === 'string' ? plan.fields.assigneeEmail : null;
          const assigneeUserId = assigneeEmail ? usersByEmail.get(assigneeEmail) ?? null : null;
          await this.tasks.create(actor, {
            projectId: project.id,
            title: String(plan.fields.title ?? ''),
            priority: (plan.fields.priority as Priority) ?? 'Medium',
            type: (plan.fields.type as TaskType) ?? 'Task',
            ...(plan.fields.description ? { description: String(plan.fields.description) } : {}),
            ...(assigneeUserId ? { assigneeUserId } : {}),
            ...(plan.fields.dueDate ? { dueDate: new Date(String(plan.fields.dueDate)) } : {}),
          });
          await this.runs.increment(runId, 'created');
          lastSuccessfulIdx = processed;
        } catch (err) {
          errors.push({
            rowIndex: plan.rowIndex,
            reason: err instanceof Error ? err.message : 'task create failed',
          });
          await this.runs.increment(runId, 'errored');
        }
        processed += 1;
      }
      await this.runs.finish({
        runId,
        status: errors.length === plans.length && plans.length > 0 ? 'failed' : 'succeeded',
        errorSummary: errors.length > 0 ? errors.slice(0, 10).map((e) => e.reason).join('\n') : null,
      });
    } catch (err) {
      // Mid-import crash — persist resume point so the run can be picked up.
      await this.prisma.importRun.update({
        where: { id: runId },
        data: {
          resumableFromRow: lastSuccessfulIdx,
          // JSON-shape cast: JiraCsvMapping is structurally JSON-compatible
          // but its strict interface (no string index signature) trips
          // Prisma's `InputJsonValue` check. Cast through unknown.
          resumePayload: {
            kind: 'jira-csv',
            csvText,
            mapping,
            projectId: project.id,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.runs.finish({
        runId,
        status: 'failed',
        errorSummary: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    return { runId };
  }
}

// ---------------------------------------------------------------------------
// CSV parser (RFC-4180 subset). Duplicated from import.service.ts so adding
// or removing the jira-csv module doesn't drag in csv-side internals. Small
// enough to live twice; revisit if a third caller appears.
// ---------------------------------------------------------------------------

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
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      if (row.length > 1 || (row.length === 1 && row[0]!.length > 0)) rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  return rows;
}
