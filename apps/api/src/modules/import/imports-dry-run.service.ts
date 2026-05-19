import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Priority, TaskType, WorkflowPreset } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import {
  JIRA_STATUS_PRESETS,
  type JiraCsvMapping,
} from './jira-csv/jira-csv.importer';

// =============================================================================
// imports-dry-run.service.ts (Pass D — Imports overhaul)
//
// Unified dry-run gateway. The Pass-D mapper UI calls a SINGLE endpoint
// regardless of source — POST /import/dry-run — and the service fans out to
// the right validator based on `source`. Responses are normalised to the
// shape the mapper UI's Step 3 renders:
//
//   {
//     preview: Array<{ row: number, fields: Record<string, unknown>, validationErrors: string[] }>,
//     wouldInsert: number,
//     wouldSkip: number,
//   }
//
// The previous per-source dry-run endpoints (csv/commit?dryRun=true, etc.)
// remain working for back-compat; this service is the new path the mapper UI
// uses end-to-end.
//
// Sources supported: 'csv' | 'linear' | 'jira-csv'.
//   - csv:       inline payload { csvText, mapping (col-idx → field) }.
//   - linear:    inline payload { sample: Array<LinearIssueLite> } — the
//                frontend fetches the first 50 issues via the existing
//                /import/linear/preview path and reposts them here so the
//                dry-run validator can run without re-fetching from Linear.
//   - jira-csv:  inline payload { csvText, projectId } + JiraCsvMapping.
//
// All paths parse + validate the first 50 rows ONLY; persistent state is
// untouched.
// =============================================================================

export interface DryRunPreviewRow {
  /** 1-based row number in the source (header = row 1 for spreadsheets). */
  row: number;
  /** Field-keyed projection of what the importer would insert. */
  fields: Record<string, unknown>;
  /** Flat list of validation errors for this row. Each entry is a
   *  human-readable sentence — UI renders them inline below the row. */
  validationErrors: string[];
}

export interface DryRunResponse {
  preview: DryRunPreviewRow[];
  /** Rows the importer WOULD insert if the user confirmed. */
  wouldInsert: number;
  /** Rows the importer would skip silently (empty title, etc.). */
  wouldSkip: number;
}

export interface DryRunPayloadCsv {
  source: 'csv';
  projectId: string;
  csvText: string;
  mapping: Record<number, string>;
}

export interface LinearIssueLite {
  identifier: string;
  title: string;
  status: string;
  priority: number | string;
  assigneeEmail: string | null;
  dueDate: string | null;
  labels?: string[];
}

export interface DryRunPayloadLinear {
  source: 'linear';
  /** Pre-fetched first 50 issues from /import/linear/preview. Pre-fetching
   *  keeps this endpoint synchronous (no GraphQL round-trips inside the
   *  dry-run path). */
  sample: LinearIssueLite[];
  mapping?: {
    preset?: WorkflowPreset;
    statusByType?: Record<string, string>;
  };
}

export interface DryRunPayloadJiraCsv {
  source: 'jira-csv';
  projectId: string;
  csvText: string;
  mapping: JiraCsvMapping;
}

export type DryRunPayload =
  | DryRunPayloadCsv
  | DryRunPayloadLinear
  | DryRunPayloadJiraCsv;

/** Number of rows the dry-run preview surfaces back to the UI. The mapper
 *  shows the first 50; rows beyond that are still counted toward
 *  wouldInsert / wouldSkip but aren't rendered. */
export const DRY_RUN_PREVIEW_ROW_LIMIT = 50;

const PRIORITY_ALIASES: Record<string, Priority> = {
  critical: 'Critical', crit: 'Critical', p0: 'Critical', urgent: 'Critical',
  highest: 'Critical',
  high: 'High', p1: 'High',
  medium: 'Medium', med: 'Medium', normal: 'Medium', p2: 'Medium',
  low: 'Low', p3: 'Low', minor: 'Low', lowest: 'Low',
};
const TYPE_ALIASES: Record<string, TaskType> = {
  task: 'Task',
  bug: 'Bug',
  defect: 'Bug',
  story: 'Story',
  epic: 'Epic',
  subtask: 'Subtask',
  'sub-task': 'Subtask',
};

@Injectable()
export class ImportsDryRunService {
  private readonly logger = new Logger(ImportsDryRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Single entrypoint for the mapper UI's Step 3. Dispatches by source and
   * returns the normalized {preview, wouldInsert, wouldSkip} envelope.
   */
  async dryRun(
    actor: AuthenticatedUser,
    payload: DryRunPayload,
  ): Promise<DryRunResponse> {
    switch (payload.source) {
      case 'csv':
        return this.dryRunCsv(actor, payload);
      case 'linear':
        return this.dryRunLinear(payload);
      case 'jira-csv':
        return this.dryRunJiraCsv(actor, payload);
      default: {
        const exhaustive: never = payload;
        throw new BadRequestException(
          `Unsupported dry-run source: ${String((exhaustive as { source: string }).source)}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // CSV path
  // ---------------------------------------------------------------------------

  private async dryRunCsv(
    actor: AuthenticatedUser,
    payload: DryRunPayloadCsv,
  ): Promise<DryRunResponse> {
    await this.assertProjectAccess(actor, payload.projectId);

    const rows = parseCsv(payload.csvText);
    if (rows.length < 2) {
      throw new BadRequestException(
        'CSV must have a header row plus at least one data row',
      );
    }
    const data = rows.slice(1);
    const fieldToCol: Record<string, number | undefined> = {};
    for (const [colStr, field] of Object.entries(payload.mapping)) {
      if (field === 'skip') continue;
      fieldToCol[field] = Number(colStr);
    }
    if (fieldToCol['title'] === undefined) {
      throw new BadRequestException(
        'At least one column must be mapped to "title"',
      );
    }

    const preview: DryRunPreviewRow[] = [];
    let wouldInsert = 0;
    let wouldSkip = 0;

    data.forEach((row, i) => {
      const lineNo = i + 2;
      const fields: Record<string, unknown> = {};
      const errors: string[] = [];

      const title = (row[fieldToCol['title']!] ?? '').trim();
      if (!title) {
        wouldSkip += 1;
        if (i < DRY_RUN_PREVIEW_ROW_LIMIT) {
          preview.push({ row: lineNo, fields: { title: null }, validationErrors: [] });
        }
        return;
      }
      fields['title'] = title;

      const desc = fieldToCol['description'];
      if (desc !== undefined && (row[desc] ?? '').trim()) fields['description'] = row[desc]!.trim();

      const prioCol = fieldToCol['priority'];
      if (prioCol !== undefined) {
        const raw = (row[prioCol] ?? '').trim();
        if (raw) {
          const v = PRIORITY_ALIASES[raw.toLowerCase()];
          if (!v) {
            errors.push(`Unknown priority "${raw}"; expected Critical/High/Medium/Low`);
          } else {
            fields['priority'] = v;
          }
        }
      }

      const typeCol = fieldToCol['type'];
      if (typeCol !== undefined) {
        const raw = (row[typeCol] ?? '').trim();
        if (raw) {
          const v = TYPE_ALIASES[raw.toLowerCase()];
          if (!v) {
            errors.push(`Unknown type "${raw}"; expected Task/Bug/Story/Epic/Subtask`);
          } else {
            fields['type'] = v;
          }
        }
      }

      const emailCol = fieldToCol['assigneeEmail'];
      if (emailCol !== undefined) {
        const raw = (row[emailCol] ?? '').trim().toLowerCase();
        if (raw) {
          if (!raw.includes('@')) {
            errors.push(`Assignee "${raw}" is not a valid email address`);
          } else {
            fields['assigneeEmail'] = raw;
          }
        }
      }

      const dueCol = fieldToCol['dueDate'];
      if (dueCol !== undefined) {
        const raw = (row[dueCol] ?? '').trim();
        if (raw) {
          const d = new Date(raw);
          if (Number.isNaN(d.getTime())) {
            errors.push(`Due date "${raw}" is not a valid date (try ISO format: YYYY-MM-DD)`);
          } else {
            fields['dueDate'] = d.toISOString().slice(0, 10);
          }
        }
      }

      const estCol = fieldToCol['estimate'];
      if (estCol !== undefined) {
        const raw = (row[estCol] ?? '').trim();
        if (raw) {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) {
            errors.push(`Estimate "${raw}" is not a positive number`);
          } else {
            fields['estimate'] = n;
          }
        }
      }

      if (errors.length === 0) wouldInsert += 1;
      if (i < DRY_RUN_PREVIEW_ROW_LIMIT) {
        preview.push({ row: lineNo, fields, validationErrors: errors });
      }
    });

    return { preview, wouldInsert, wouldSkip };
  }

  // ---------------------------------------------------------------------------
  // Linear path — operates on a pre-fetched sample so this endpoint stays
  // hermetic (no live GraphQL calls inside dry-run).
  // ---------------------------------------------------------------------------

  private async dryRunLinear(
    payload: DryRunPayloadLinear,
  ): Promise<DryRunResponse> {
    const preview: DryRunPreviewRow[] = [];
    let wouldInsert = 0;
    let wouldSkip = 0;

    payload.sample.forEach((iss, i) => {
      const rowNo = i + 1;
      const fields: Record<string, unknown> = {};
      const errors: string[] = [];

      const title = (iss.title ?? '').trim();
      if (!title) {
        wouldSkip += 1;
        if (i < DRY_RUN_PREVIEW_ROW_LIMIT) {
          preview.push({ row: rowNo, fields: { identifier: iss.identifier, title: null }, validationErrors: [] });
        }
        return;
      }
      fields['identifier'] = iss.identifier;
      fields['title'] = title;
      fields['status'] = iss.status;

      const prio = typeof iss.priority === 'number'
        ? mapLinearPriority(iss.priority)
        : PRIORITY_ALIASES[String(iss.priority ?? '').toLowerCase()];
      if (iss.priority !== undefined && iss.priority !== null) {
        if (!prio) {
          errors.push(`Unknown priority "${String(iss.priority)}"`);
        } else {
          fields['priority'] = prio;
        }
      }

      if (iss.assigneeEmail) {
        if (!iss.assigneeEmail.includes('@')) {
          errors.push(`Assignee "${iss.assigneeEmail}" is not a valid email address`);
        } else {
          fields['assigneeEmail'] = iss.assigneeEmail.toLowerCase();
        }
      }
      if (iss.dueDate) {
        const d = new Date(iss.dueDate);
        if (Number.isNaN(d.getTime())) {
          errors.push(`Due date "${iss.dueDate}" is not a valid date`);
        } else {
          fields['dueDate'] = d.toISOString().slice(0, 10);
        }
      }
      if (iss.labels && iss.labels.length > 0) fields['labels'] = iss.labels.join(', ');

      if (errors.length === 0) wouldInsert += 1;
      if (i < DRY_RUN_PREVIEW_ROW_LIMIT) {
        preview.push({ row: rowNo, fields, validationErrors: errors });
      }
    });

    return { preview, wouldInsert, wouldSkip };
  }

  // ---------------------------------------------------------------------------
  // Jira-CSV path — parses inline and runs the same validation pipeline the
  // real run uses.
  // ---------------------------------------------------------------------------

  private async dryRunJiraCsv(
    actor: AuthenticatedUser,
    payload: DryRunPayloadJiraCsv,
  ): Promise<DryRunResponse> {
    await this.assertProjectAccess(actor, payload.projectId);

    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: payload.projectId },
      select: { id: true, workflowPreset: true },
    });

    const presetKey = payload.mapping.preset ?? project.workflowPreset;
    const presetTable = JIRA_STATUS_PRESETS[presetKey] ?? JIRA_STATUS_PRESETS.generic;

    // Global JiraStatusMap rows take precedence over the preset
    // table but lose to the per-run statusOverrides supplied by the user.
    const wsOverrides = await this.prisma.jiraStatusMap.findMany({
      select: { jiraStatus: true, nocktaStatus: true },
    });
    const statusTable: Record<string, string> = { ...presetTable };
    for (const r of wsOverrides) statusTable[r.jiraStatus.toLowerCase()] = r.nocktaStatus;
    for (const [k, v] of Object.entries(payload.mapping.statusOverrides ?? {})) {
      statusTable[k.toLowerCase()] = v;
    }

    const parsed = parseJiraCsv(payload.csvText);

    const preview: DryRunPreviewRow[] = [];
    let wouldInsert = 0;
    let wouldSkip = 0;
    const columnMap = payload.mapping.columnMap ?? {};

    parsed.forEach((row, i) => {
      const fields: Record<string, unknown> = {};
      const errors: string[] = [];

      const sourceFor = (canonical: string): string | string[] | undefined => {
        const remappedKey = Object.entries(columnMap).find(([, v]) => v === canonical)?.[0];
        const key = remappedKey ?? canonical;
        return row.fields[key];
      };

      const title = String(sourceFor('Summary') ?? '').trim();
      if (!title) {
        wouldSkip += 1;
        if (i < DRY_RUN_PREVIEW_ROW_LIMIT) {
          preview.push({ row: row.rowIndex, fields: { title: null }, validationErrors: [] });
        }
        return;
      }
      fields['title'] = title;

      const desc = sourceFor('Description');
      if (desc !== undefined) fields['description'] = String(desc);

      const prioRaw = String(sourceFor('Priority') ?? '').trim();
      if (prioRaw) {
        const v = PRIORITY_ALIASES[prioRaw.toLowerCase()];
        if (!v) errors.push(`Unknown priority "${prioRaw}"; expected Highest/High/Medium/Low/Lowest`);
        else fields['priority'] = v;
      }

      const typeRaw = String(sourceFor('Issue Type') ?? '').trim();
      if (typeRaw) {
        const v = TYPE_ALIASES[typeRaw.toLowerCase()];
        if (!v) errors.push(`Unknown type "${typeRaw}"; expected Task/Bug/Story/Epic/Subtask`);
        else fields['type'] = v;
      }

      const statusRaw = String(sourceFor('Status') ?? '').trim();
      if (statusRaw) {
        fields['status'] = statusTable[statusRaw.toLowerCase()] ?? mapStatusFallback(statusRaw);
      }

      const emailRaw = String(sourceFor('Assignee Email') ?? '').trim();
      if (emailRaw) {
        if (!emailRaw.includes('@')) {
          errors.push(`Assignee email "${emailRaw}" is not a valid email address`);
        } else {
          fields['assigneeEmail'] = emailRaw.toLowerCase();
        }
      }

      const dueRaw = String(sourceFor('Due date') ?? '').trim();
      if (dueRaw) {
        const d = new Date(dueRaw);
        if (Number.isNaN(d.getTime())) {
          errors.push(`Due date "${dueRaw}" is not a valid date (try ISO format: YYYY-MM-DD)`);
        } else {
          fields['dueDate'] = d.toISOString().slice(0, 10);
        }
      }

      const labels = sourceFor('Labels');
      if (labels !== undefined) {
        const list = Array.isArray(labels) ? labels : [labels];
        fields['labels'] = list.join(', ');
      }

      if (errors.length === 0) wouldInsert += 1;
      if (i < DRY_RUN_PREVIEW_ROW_LIMIT) {
        preview.push({ row: row.rowIndex, fields, validationErrors: errors });
      }
    });

    return { preview, wouldInsert, wouldSkip };
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private async assertProjectAccess(actor: AuthenticatedUser, projectId: string): Promise<void> {
    const role = await this.permissions.effectiveRole(actor, projectId);
    if (role === null) throw new ForbiddenException('No access to project');
    if (role === 'Client' || role === 'Viewer') {
      throw new ForbiddenException('Insufficient role for import');
    }
  }
}

function mapLinearPriority(linearPriority: number): Priority {
  switch (linearPriority) {
    case 1:
      return 'Critical';
    case 2:
      return 'High';
    case 3:
      return 'Medium';
    case 4:
      return 'Low';
    default:
      return 'Medium';
  }
}

function mapStatusFallback(raw: string): string {
  const v = raw.toLowerCase().trim();
  if (['done', 'closed', 'resolved', 'cancelled'].includes(v)) return 'Done';
  if (['in progress', 'doing', 'active', 'in development'].includes(v)) return 'In Progress';
  if (['in review', 'code review', 'qa', 'testing'].includes(v)) return 'In Review';
  return 'Todo';
}

// ---------------------------------------------------------------------------
// Standalone CSV parsers — duplicated from import.service.ts intentionally so
// the dry-run path doesn't import the heavy ImportService just for tokenising.
// Adding/removing dry-run support is one file's churn instead of a circular
// dependency. The two implementations are tiny and trivially comparable.
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

interface JiraParsedRow {
  rowIndex: number;
  fields: Record<string, string | string[]>;
}

function parseJiraCsv(text: string): JiraParsedRow[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new BadRequestException('CSV is empty');
  const [headers, ...data] = rows;
  if (!headers || headers.length === 0) {
    throw new BadRequestException('CSV has no header row');
  }
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
          .map((idx) => (row[idx] ?? '').trim())
          .filter((v) => v.length > 0);
        if (vals.length > 0) fields[header] = vals;
      }
    }
    return { rowIndex: di + 2, fields };
  });
}
