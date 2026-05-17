// =============================================================================
// csv/csv.importer.ts (Pass D split)
//
// The CSV adapter is a special case: the source fields aren't known until the
// user uploads the file, so the descriptor list is BUILT at parse time from
// the header row (see buildCsvFieldDescriptors). The actual parse / commit /
// dry-run logic still lives in `../import.service.ts`; this file is the
// adapter-shape facade so the mapper UI can treat CSV like any other source.
// =============================================================================

import type {
  ImportSourceFieldDescriptor,
  NocktaFieldKey,
} from '../adapter.types';

/**
 * Build descriptors for an uploaded CSV given its header row + first few
 * data rows. The descriptor `key` is the zero-based column index as a
 * string (matches the existing mapping payload shape).
 */
export function buildCsvFieldDescriptors(
  headers: string[],
  sampleRows: string[][],
): ImportSourceFieldDescriptor[] {
  return headers.map((header, idx) => {
    // Pull the first non-empty sample value for the column so the UI can
    // render a hint without forcing the user to expand the row preview.
    const sample =
      sampleRows
        .map((r) => r[idx])
        .find((v) => v !== undefined && v !== null && String(v).trim().length > 0) ?? undefined;
    return {
      key: String(idx),
      label: header || `Column ${idx + 1}`,
      ...(sample !== undefined ? { sample: String(sample).slice(0, 60) } : {}),
      suggestedFieldKey: guessFieldFromHeader(header),
    };
  });
}

/**
 * Heuristic header → Nockta field. Same set of aliases the existing
 * ImportCenterTab uses on the frontend — kept here so the API can return
 * suggestions inline with the descriptor list rather than relying on the
 * UI re-running the heuristic.
 */
export function guessFieldFromHeader(header: string): NocktaFieldKey {
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

/** Re-exported alias for the shape consumers expect on the adapter. */
export type CsvSourceFieldDescriptor = ImportSourceFieldDescriptor;
