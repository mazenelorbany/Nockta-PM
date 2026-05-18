// =============================================================================
// Parsed-filter chip support (Search 7→9). We mirror the server-side grammar
// in `search.service.parseQuery` here so the chips can render BEFORE the
// query round-trips. The server is authoritative — if our parser disagrees
// the API still does the right thing — but a same-tick UI is the whole point
// of these chips. Keep the regex in sync with the backend.
// =============================================================================

const FILTER_TOKEN_REGEX = /(\w+):(?:"([^"]+)"|(\S+))/g;
const KNOWN_KEYS = new Set(['status', 'assignee', 'label', 'priority', 'created']);

export interface ChipModel {
  key: string;
  value: string;
  raw: string; // the full matched token, used to strip from the input on dismiss
}

export function parseChips(input: string): { chips: ChipModel[]; remainingText: string } {
  const chips: ChipModel[] = [];
  const matches: { start: number; end: number; chip: ChipModel | null }[] = [];
  for (const m of input.matchAll(FILTER_TOKEN_REGEX)) {
    const key = m[1]!.toLowerCase();
    const value = m[2] !== undefined ? m[2] : (m[3] ?? '');
    const start = m.index ?? 0;
    const end = start + m[0]!.length;
    if (KNOWN_KEYS.has(key)) {
      const chip: ChipModel = { key, value, raw: m[0]! };
      chips.push(chip);
      matches.push({ start, end, chip });
    } else {
      // Unknown keys aren't chips — they're free-text-with-a-colon.
    }
  }
  // Strip consumed ranges from the original input to compute remainingText.
  let text = input;
  matches
    .slice()
    .sort((a, b) => b.start - a.start)
    .forEach((m) => {
      text = text.slice(0, m.start) + text.slice(m.end);
    });
  return { chips, remainingText: text.replace(/\s+/g, ' ').trim() };
}
