// =============================================================================
// User-map parser for the importers.
//
// Why: Atlassian (Jira) and Linear both hide user email addresses by default
// for privacy. When that's the case the importer falls back to a stub email
// like `${accountId}@jira-imported.local`, which orphans the user from their
// real `@nockta.com` Google login.
//
// This module parses a small CSV (or TSV) supplied at import time and
// returns a `Map<accountId, {email, name?}>` that the importer consults
// before any stub-email fallback. Format:
//
//   accountId,email,name
//   5f7a8b9c-1234-aaaa-bbbb-cccccccccccc,alice@nockta.com,Alice Builder
//   5d9e8a7b-1111-2222-3333-444444444444,bob@nockta.com
//
// First line may be a header (`accountId,email,name` or any common variant);
// the parser detects it and skips it.
//
// Validation:
//   - Empty / comment lines (`#…`) are skipped.
//   - Rows without a valid email throw — the importer should fail loudly
//     rather than silently use the stub for that user.
//   - Duplicate accountIds throw too (almost certainly a CSV mistake).
// =============================================================================


export interface UserMapEntry {
  email: string;
  name?: string;
}

const HEADER_VARIANTS = new Set([
  'accountid',
  'jira-accountid',
  'linear-accountid',
  'id',
  'user-id',
]);

/**
 * Parse user-map CSV (or TSV) text into a Map.
 *
 * Exposed separately from the file-reading wrapper so tests can exercise
 * the parser without touching the filesystem.
 */
export function parseUserMapText(
  text: string,
  source: string = '<inline>',
): Map<string, UserMapEntry> {
  const out = new Map<string, UserMapEntry>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    // Detect either CSV or TSV by sniffing the first separator.
    const sep = line.includes('\t') && !line.includes(',') ? '\t' : ',';
    const cells = line.split(sep).map((c) => c.trim());

    // Skip a header row on the first non-empty line.
    if (i === 0 || (out.size === 0 && i < 3)) {
      const first = cells[0]?.toLowerCase() ?? '';
      if (HEADER_VARIANTS.has(first) || first === 'accountid') continue;
    }

    const [accountId, email, name] = cells;
    if (!accountId) {
      throw new Error(`${source}:${i + 1} — missing accountId`);
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`${source}:${i + 1} — invalid or missing email for accountId=${accountId}`);
    }
    if (out.has(accountId)) {
      throw new Error(
        `${source}:${i + 1} — duplicate accountId=${accountId} (already mapped to ${out.get(accountId)?.email})`,
      );
    }
    const entry: UserMapEntry = { email: email.toLowerCase() };
    if (name) entry.name = name;
    out.set(accountId, entry);
  }
  return out;
}

