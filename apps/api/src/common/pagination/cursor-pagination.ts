/**
 * Opaque cursor — base64-encoded `id|createdAt` (or whatever sort tuple was used).
 * Stable across runs because we always order by (created_at desc, id desc) or similar.
 *
 * `Paginated` was previously imported from `@nockta/types`, but the api's
 * tsconfig has `rootDir: ./src` (so `dist/main.js` lives at the right path),
 * and tsc rejects type-only imports that resolve outside rootDir. We inline
 * the type here since the api is the only consumer of this shape on the
 * backend. Keep this in sync with packages/types/src/api.ts.
 */

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface CursorParams {
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function normalizeLimit(limit: number | undefined): number {
  if (!limit) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
}

export function encodeCursor(parts: (string | number | Date)[]): string {
  const raw = parts
    .map((p) => (p instanceof Date ? p.toISOString() : String(p)))
    .join('|');
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string[] {
  return Buffer.from(cursor, 'base64url').toString('utf8').split('|');
}

export function paginate<T>(
  items: T[],
  limit: number,
  cursorFor: (item: T) => string,
): Paginated<T> {
  const hasMore = items.length > limit;
  const sliced = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? cursorFor(sliced[sliced.length - 1]!) : null;
  return { items: sliced, nextCursor };
}
