// Free-text query parser for the search service. Pulls structured filters
// (status:, assignee:, label:, priority:, created:) out of the search box and
// returns the residual text that goes on to FTS / OpenSearch. Bad filter
// values degrade gracefully: the parser surfaces a parseError and leaves the
// raw token in `text` so the user still gets results.

const PRIORITY_VALUES = ['Low', 'Medium', 'High', 'Critical'] as const;
export type PriorityVal = (typeof PRIORITY_VALUES)[number];
export function isPriority(v: string): v is PriorityVal {
  return (PRIORITY_VALUES as readonly string[]).includes(v);
}

/**
 * Structured filters extracted from the free-text query by parseQuery(). Each
 * field is independent; a filter that didn't appear in the input is left
 * undefined. `dateRange` covers both `created:>7d` and `created:<2024-01-01`
 * shapes — the parser fills `from` and/or `to` from those.
 */
export interface ParsedFilters {
  status?: string;
  assignee?: { kind: 'me' } | { kind: 'email'; email: string };
  labels?: string[];
  priorities?: PriorityVal[];
  dateRange?: { from?: Date; to?: Date };
}

export interface ParsedQuery {
  text: string;
  filters: ParsedFilters;
  parseError?: string;
}

/**
 * Token regex used by parseQuery — captures the leading `key:` plus its value.
 * The value is either a double-quoted string (whitespace allowed) or a bare
 * sequence of non-whitespace characters. Capture groups:
 *   1: key
 *   2: quoted value (double-quote-bounded; quotes stripped)
 *   3: bare value
 * One of (2, 3) is always populated when the regex matches.
 */
const FILTER_TOKEN_REGEX = /(\w+):(?:"([^"]+)"|(\S+))/g;

/**
 * Pull structured filters out of the free-text query. Grammar:
 *
 *   status:open                    → status filter (case-preserving)
 *   status:"in progress"           → quoted value, whitespace allowed
 *   assignee:me                    → assignee = current actor
 *   assignee:@person@example.com   → assignee by email
 *   label:bug                      → single label
 *   label:"front end"              → quoted label name
 *   priority:high                  → single priority (allowed Low/Medium/High/Critical, case-insensitive)
 *   priority:high|critical         → multi-priority via `|`
 *   created:>7d                    → created in the last 7 days (also 1h, 30m, 1mo, 1y)
 *   created:<2024-01-01            → created strictly before that ISO date
 *   created:>=2024-01-01           → ≥/<= variants accepted
 *   created:2024-01-01..2024-02-01 → range form
 *
 * Anything not matched stays in `text` for FTS. Bad ranges / unknown
 * operators degrade gracefully: we set `parseError`, drop the bad filter,
 * and leave the raw token in `text` so the user still gets results.
 */
export function parseQuery(raw: string): ParsedQuery {
  const filters: ParsedFilters = {};
  let parseError: string | undefined;
  // Walk every key:value match, removing it from the text we'll return.
  // We intentionally rebuild `text` by splicing matched ranges out so that
  // whitespace around the token doesn't degenerate into double-spaces.
  const matches: { start: number; end: number; key: string; value: string }[] = [];
  for (const m of raw.matchAll(FILTER_TOKEN_REGEX)) {
    const key = m[1]!.toLowerCase();
    const value = m[2] !== undefined ? m[2] : (m[3] ?? '');
    // The match index points to the start of `key:`. We need the end of the
    // FULL match including any closing quote.
    const start = m.index ?? 0;
    const end = start + m[0]!.length;
    // Apply each known key. Unknown keys are LEFT in text — they might be a
    // colon-bearing word the user actually wants to FTS on.
    const handled = applyFilterToken(key, value, filters);
    if (handled === 'invalid') {
      // Bad value (e.g. created:>asdf) — capture the FIRST error and leave
      // the token in text. Subsequent good tokens still apply.
      if (parseError === undefined) {
        parseError = `Could not parse "${key}:${value}"`;
      }
      continue;
    }
    if (handled === 'consumed') {
      matches.push({ start, end, key, value });
    }
  }
  // Splice consumed matches out of the original input, preserving order.
  let text = raw;
  matches
    .slice()
    .sort((a, b) => b.start - a.start)
    .forEach((m) => {
      text = text.slice(0, m.start) + text.slice(m.end);
    });
  // Collapse double-whitespace introduced by removal.
  text = text.replace(/\s+/g, ' ').trim();
  return parseError !== undefined ? { text, filters, parseError } : { text, filters };
}

/**
 * Apply a single filter token to the accumulator. Returns 'consumed' when
 * the token was recognized and applied, 'invalid' when the key is known but
 * the value couldn't be parsed (caller sets parseError + leaves token in
 * text), 'unknown' when the key isn't one we recognize (caller leaves
 * token in text without flagging an error).
 */
function applyFilterToken(
  key: string,
  value: string,
  filters: ParsedFilters,
): 'consumed' | 'invalid' | 'unknown' {
  if (value.length === 0) return 'unknown';
  switch (key) {
    case 'status': {
      filters.status = value;
      return 'consumed';
    }
    case 'assignee': {
      if (value === 'me') {
        filters.assignee = { kind: 'me' };
      } else {
        // Accept @email or bare email.
        const email = value.startsWith('@') ? value.slice(1) : value;
        if (!email.includes('@')) return 'invalid';
        filters.assignee = { kind: 'email', email };
      }
      return 'consumed';
    }
    case 'label': {
      (filters.labels ??= []).push(value);
      return 'consumed';
    }
    case 'priority': {
      // `priority:high|critical` → multi-select.
      const parts = value.split('|').map((p) => p.trim()).filter(Boolean);
      const accepted: PriorityVal[] = [];
      for (const p of parts) {
        const cap = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
        if (!isPriority(cap)) return 'invalid';
        accepted.push(cap);
      }
      if (accepted.length === 0) return 'invalid';
      filters.priorities = [...(filters.priorities ?? []), ...accepted];
      return 'consumed';
    }
    case 'created': {
      const range = parseDateRangeOp(value);
      if (range === null) return 'invalid';
      const cur = filters.dateRange ?? {};
      if (range.from !== undefined) cur.from = range.from;
      if (range.to !== undefined) cur.to = range.to;
      filters.dateRange = cur;
      return 'consumed';
    }
    default:
      return 'unknown';
  }
}

/**
 * Parse the value half of `created:<op><value>`. Returns null on garbage.
 * Supported forms:
 *   >7d        → from = now - 7d
 *   <2024-01-01 → to   = that ISO date (00:00:00 UTC)
 *   >=2024-01-01 / <=
 *   2024-01-01..2024-02-01 → both ends inclusive
 *
 * Relative units: m=minutes, h=hours, d=days, w=weeks, mo=months (30d),
 * y=years (365d). We deliberately keep month/year naive — calendar math
 * here would gain very little for an ad-hoc filter.
 */
function parseDateRangeOp(value: string): { from?: Date; to?: Date } | null {
  // Range form `A..B`
  const rangeMatch = /^([^.]+)\.\.([^.]+)$/.exec(value);
  if (rangeMatch) {
    const a = parseRelOrAbsDate(rangeMatch[1]!);
    const b = parseRelOrAbsDate(rangeMatch[2]!);
    if (a === null || b === null) return null;
    return { from: a, to: b };
  }
  // Operator forms — accept >=, <=, >, <. No operator → treat as
  // single-day window (>= start, < next-day). We don't currently expose
  // that to users; the keyword grammar always demands an operator.
  const opMatch = /^(>=|<=|>|<)(.+)$/.exec(value);
  if (!opMatch) return null;
  const op = opMatch[1]!;
  const rest = opMatch[2]!;
  const date = parseRelOrAbsDate(rest);
  if (date === null) return null;
  switch (op) {
    case '>':
    case '>=':
      return { from: date };
    case '<':
    case '<=':
      return { to: date };
    default:
      return null;
  }
}

/**
 * Parse either a relative window (`7d`, `30m`, `1mo`) or an ISO date
 * (`2024-01-01` / full `2024-01-01T12:34:00Z`). Returns null on garbage.
 * For relative windows we compute now-minus-window so the filter is
 * "everything created after T".
 */
function parseRelOrAbsDate(value: string): Date | null {
  // Relative: number + unit (m|h|d|w|mo|y). `mo` is checked before `m`
  // because mo is a longer prefix.
  const rel = /^(\d+)(mo|m|h|d|w|y)$/.exec(value);
  if (rel) {
    const n = Number.parseInt(rel[1]!, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = rel[2]!;
    const ms =
      unit === 'm'
        ? n * 60 * 1000
        : unit === 'h'
        ? n * 60 * 60 * 1000
        : unit === 'd'
        ? n * 24 * 60 * 60 * 1000
        : unit === 'w'
        ? n * 7 * 24 * 60 * 60 * 1000
        : unit === 'mo'
        ? n * 30 * 24 * 60 * 60 * 1000
        : unit === 'y'
        ? n * 365 * 24 * 60 * 60 * 1000
        : NaN;
    if (!Number.isFinite(ms)) return null;
    return new Date(Date.now() - ms);
  }
  // Absolute ISO: Date constructor accepts `YYYY-MM-DD` and full ISO. We
  // explicitly reject NaN to weed out garbage like `2024-13-40`.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}
