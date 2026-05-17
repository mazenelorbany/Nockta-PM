/**
 * Scans free-form text (commit messages, PR titles/descriptions, branch names)
 * for project task references like `MOB-42` and returns the unique set.
 */

const KEY_PATTERN = /\b([A-Z]{2,10})-(\d+)\b/g;

export interface ParsedKey {
  key: string;        // "MOB-42"
  projectKey: string; // "MOB"
  keyNumber: number;  // 42
}

export function parseTaskKeys(...texts: (string | null | undefined)[]): ParsedKey[] {
  const seen = new Set<string>();
  const out: ParsedKey[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(KEY_PATTERN)) {
      const key = m[0]!;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, projectKey: m[1]!, keyNumber: Number(m[2]!) });
    }
  }
  return out;
}
