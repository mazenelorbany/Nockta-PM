export type ImportTabKey = 'csv' | 'linear' | 'github' | 'jira' | 'jira-csv';

export interface ImportRunSummary {
  id: string;
  source: 'csv' | 'linear' | 'jira' | 'github_issues';
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  sourceRef: string | null;
  totalRows: number;
  createdRows: number;
  skippedRows: number;
  erroredRows: number;
  startedAt: string;
  finishedAt: string | null;
  errorSummary: string | null;
  /** Pass D — set when a run failed mid-stream; the runs table renders a
   *  "Resume" button that re-plays from `resumableFromRow + 1` via
   *  POST /import/:id/resume. */
  resumableFromRow?: number | null;
  lastError?: string | null;
  mappingSnapshot?: unknown;
  actor?: { id: string; name: string; email: string } | null;
  project?: { id: string; key: string; name: string } | null;
}

/** Field descriptor as returned by GET /import/source-fields?source=… */
export interface ImportSourceFieldPayload {
  sourceKey: string;
  label: string;
  requiredFor: 'always' | 'optional';
  defaultTargetField?: string;
  description?: string;
  sample?: string;
}

/** Normalized response from POST /import/dry-run — the mapper UI's Step 3. */
export interface DryRunResponsePayload {
  preview: Array<{
    row: number;
    fields: Record<string, unknown>;
    validationErrors: string[];
  }>;
  wouldInsert: number;
  wouldSkip: number;
}
