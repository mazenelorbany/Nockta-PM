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

import type { ImportSourceField } from '../adapter.types';

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
