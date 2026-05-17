// =============================================================================
// API request/response shapes — pagination, errors, common envelopes.
// =============================================================================

/** Cursor-based pagination input. */
export interface PaginationInput {
  cursor?: string;
  limit?: number;
}

/** Cursor-based pagination response envelope. */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

/** RFC 7807 problem details. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Extension fields — e.g. validation errors per field. */
  [key: string]: unknown;
}
