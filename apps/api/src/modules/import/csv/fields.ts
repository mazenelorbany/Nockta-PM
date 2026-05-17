// =============================================================================
// csv/fields.ts (Pass D)
//
// The CSV adapter is the special case: source columns aren't known until
// upload, so its field list is BUILT at parse time from the header row. This
// module exports two things:
//
//   1. `fields` — a STATIC list of "fixed" descriptors the importer always
//      knows about (the canonical Nockta target columns). Used by the
//      controller's GET /import/source-fields?source=csv endpoint when no
//      sample CSV is attached, so the mapper UI can render a useful default
//      while the user is still picking a file.
//   2. `buildFromHeaders(headers, sampleRows)` — builds a per-upload
//      descriptor list keyed by the zero-based column index, with a
//      best-guess `defaultTargetField` for each header.
//
// The shape matches every other adapter's `fields` export so the controller
// fan-out is one line of code instead of three.
// =============================================================================

import type {
  ImportSourceField,
  NocktaTaskField,
} from '../adapter.types';

/** Static "always-present" descriptors. Each one is a Nockta-side column
 *  the CSV importer can write to; the mapper UI uses them to render the
 *  right rail even when no file has been uploaded yet. */
export const fields: readonly ImportSourceField[] = [
  { sourceKey: 'title', label: 'Title', requiredFor: 'always', defaultTargetField: 'title' },
  { sourceKey: 'description', label: 'Description', requiredFor: 'optional', defaultTargetField: 'description' },
  { sourceKey: 'priority', label: 'Priority', requiredFor: 'optional', defaultTargetField: 'priority' },
  { sourceKey: 'type', label: 'Type', requiredFor: 'optional', defaultTargetField: 'type' },
  { sourceKey: 'status', label: 'Status', requiredFor: 'optional', defaultTargetField: 'status' },
  { sourceKey: 'assigneeEmail', label: 'Assignee (email)', requiredFor: 'optional', defaultTargetField: 'assigneeEmail' },
  { sourceKey: 'dueDate', label: 'Due date', requiredFor: 'optional', defaultTargetField: 'dueDate' },
  { sourceKey: 'estimate', label: 'Estimate', requiredFor: 'optional', defaultTargetField: 'estimate' },
  { sourceKey: 'labels', label: 'Labels', requiredFor: 'optional', defaultTargetField: 'labels' },
] as const;

/** Build per-upload descriptors from the parsed CSV header row + first few
 *  sample rows. The descriptor `sourceKey` is the zero-based column index
 *  as a string so the run logic can index the row array directly. */
export function buildFromHeaders(
  headers: string[],
  sampleRows: string[][],
): ImportSourceField[] {
  return headers.map((header, idx) => {
    // Pull the first non-empty sample value for the column so the UI can
    // surface a hint without forcing the user to expand the row preview.
    const sample =
      sampleRows
        .map((r) => r[idx])
        .find((v) => v !== undefined && v !== null && String(v).trim().length > 0) ?? undefined;
    return {
      sourceKey: String(idx),
      label: header || `Column ${idx + 1}`,
      requiredFor: 'optional',
      ...(sample !== undefined ? { sample: String(sample).slice(0, 60) } : {}),
      defaultTargetField: guessTargetFromHeader(header),
    };
  });
}

/**
 * Header → Nockta-target heuristic. Same alias set the legacy ImportCenterTab
 * uses on the frontend — kept here so the API can return suggestions inline
 * with the descriptor list rather than relying on the UI re-running the
 * heuristic itself.
 */
export function guessTargetFromHeader(header: string): NocktaTaskField {
  const h = header.toLowerCase().trim();
  if (/^(title|summary|name)$/.test(h)) return 'title';
  if (/^(description|details|body)$/.test(h)) return 'description';
  if (/^(priority|prio)$/.test(h)) return 'priority';
  if (/^(type|issue ?type|kind)$/.test(h)) return 'type';
  if (/^(status|state)$/.test(h)) return 'status';
  if (/(assignee.*email|owner.*email|email)/.test(h)) return 'assigneeEmail';
  if (/^(due.*date|due)$/.test(h)) return 'dueDate';
  if (/^(estimate|points|story.?points)$/.test(h)) return 'estimate';
  if (/^(label|labels|tags?)$/.test(h)) return 'labels';
  return 'skip';
}

/** Convenience type alias for downstream consumers. */
export type CsvField = ImportSourceField;
