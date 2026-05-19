// =============================================================================
// adapter.types.ts (Pass D)
//
// Shared types every importer-source adapter advertises so the mapper UI can
// render its column-mapping table without source-specific code. Each adapter
// exports a `*_SOURCE_FIELDS` array (see linear/linear.importer.ts,
// csv/csv.importer.ts, jira-csv/jira-csv.importer.ts) whose shape matches
// ImportSourceFieldDescriptor; the controller fans them out via
// GET /import/adapters.
//
// Why descriptors instead of inferring from sample data:
//   - Linear / Jira-CSV have known-stable column sets — hard-coding is more
//     correct than guessing from the first 20 rows.
//   - CSV is the special case: its descriptors are emitted dynamically by the
//     parse() endpoint based on actual headers. The same descriptor shape is
//     used so the UI doesn't need a CSV-specific render path.
// =============================================================================

/** A single mappable column / field on the source side of an importer. */
export interface ImportSourceFieldDescriptor {
  /** Stable identifier the run logic recognises. For CSV this is the
   *  zero-based column index as a string; for typed sources it's a
   *  namespaced key like "status.completed". */
  key: string;
  /** Human label shown in the mapper UI's left rail. */
  label: string;
  /** Optional explainer rendered under the label. */
  description?: string;
  /** One example value from the source — populated by adapters that can
   *  show a sample without fetching live data (or by the CSV parse path
   *  using the first non-empty row value). */
  sample?: string;
  /** Adapter's best guess for which Nockta field the column maps to. The
   *  user can override. */
  suggestedFieldKey?: NocktaFieldKey;
}

/**
 * Field descriptor consumed by per-adapter `fields.ts` modules. Same intent
 * as ImportSourceFieldDescriptor but with the naming the rest of the codebase
 * settled on in Pass D (sourceKey/requiredFor/defaultTargetField). The two
 * shapes coexist so existing controllers reading the legacy descriptor list
 * don't have to be rewritten in lockstep.
 */
export interface ImportSourceField {
  sourceKey: string;
  label: string;
  /** "always" = the source guarantees a value (e.g. Jira Issue key, Summary).
   *  "optional" = may be empty; the importer skips or defaults. */
  requiredFor: 'always' | 'optional';
  /** Pre-filled target column the mapper UI starts at. User can override. */
  defaultTargetField?: NocktaTaskField;
  /** Sample value carried over from the source (populated for CSV when
   *  buildFromHeaders runs against a real file). */
  sample?: string;
  /** Optional explainer rendered under the label. */
  description?: string;
}

/** Alias of NocktaFieldKey under the Pass-D name. New code should prefer
 *  NocktaTaskField; the legacy name is kept for the in-flight callers. */
export type NocktaTaskField = NocktaFieldKey;

/** Nockta-side fields the right rail in the mapper UI offers. Keep this
 *  list narrow on purpose — fields whose write path is identical across
 *  all importers. Per-source extensions (e.g. Linear's labels) live in the
 *  source service, not in this enum. */
export type NocktaFieldKey =
  | 'title'
  | 'description'
  | 'priority'
  | 'type'
  | 'status'
  | 'assigneeEmail'
  | 'dueDate'
  | 'estimate'
  | 'labels'
  | 'skip';

/** A row error surfaced from any importer's dry-run preview. */
export interface DryRunRowError {
  /** 1-based row number in the user-facing source (e.g. spreadsheet line). */
  row: number;
  field: string;
  message: string;
}

/** Per-row preview rendered by the mapper UI's "Step 3 — dry run". */
export interface DryRunPreviewRow {
  rowIndex: number;
  /** Field-keyed projection of what we'd insert. Null = nothing mapped. */
  fields: Record<string, string | number | null>;
  /** Errors specific to this row, keyed by field. */
  errorsByField: Record<string, string>;
}

export interface DryRunResult {
  /** First N rows projected through the mapping pipeline. */
  preview: DryRunPreviewRow[];
  /** Flat list of every validation error across all rows. */
  errors: DryRunRowError[];
  /** Rows the importer WOULD insert if the user confirmed. */
  wouldInsert: number;
  /** Rows the importer would skip silently (empty title, etc.). */
  wouldSkip: number;
  /** Total rows in the source. */
  totalRows: number;
}

